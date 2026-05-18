/**
 * RFC 8628 device-authorization flow — standalone module.
 *
 * Why this module exists:
 *   The legacy device-flow implementation was embedded inside
 *   `tools/lore_login.ts`, tightly coupling the browser-open step, the
 *   device-code mint, and the poll loop. Extracting these into pure functions
 *   here lets the MCP tool handlers (Task 5) compose them independently:
 *     1. Call `initiateDeviceCode` → get the codes to show the user.
 *     2. Do the browser-open step (or headless fallback) in the tool handler.
 *     3. Call `pollDeviceToken` → block until success, expiry, or hard cap.
 *
 * Why endpoints are discovered, not hardcoded:
 *   Both functions call `discoverEndpoints()` internally. Callers pass no
 *   endpoint URLs — the resolution chain (PRM → AS metadata → derived device
 *   endpoint) is encapsulated here. Discovery results are cached on disk with a
 *   24-hour TTL, so the per-call cost is typically a synchronous cache read.
 *
 * Credential hygiene (see also: legacy `tools/lore_login.ts`):
 *   - `device_code` is never written to error messages — it is a bearer
 *     credential until the grant expires and some servers echo it in
 *     `error_description`. We surface only the well-known OAuth `error` code.
 *   - `access_token` and `refresh_token` are never in return values — callers
 *     receive only `{ ok: true }`.
 *   - `expires_at` is computed from the local clock (`now() + expires_in * 1000`),
 *     never trusted from the server, matching the convention in `lib/refresh.ts`.
 *
 * Polling semantics (RFC 8628 §3.5):
 *   - `authorization_pending` → keep polling at the current interval.
 *   - `slow_down` → add SLOW_DOWN_INCREMENT_SECONDS permanently to the interval.
 *   - `expired_token` → return `{ ok: false, reason: 'expired_token' }`.
 *   - Hard cap: stop polling when elapsed >= `expires_in_seconds * 1000`,
 *     even if the server keeps returning `authorization_pending`. The cap is
 *     computed from a local `start = now()` taken at the top of the first
 *     iteration (NOT before sleeping) to give the first interval its full
 *     allocation.
 *
 * `startAnchor` decision: DROPPED.
 *   The legacy `pollDeviceToken` in `tools/lore_login.ts` accepted an internal
 *   `startAnchor` so `runLoreLogin` could measure time from after the
 *   device-code response. In this module, `pollDeviceToken` is a standalone
 *   entry point callable from both fresh-start and resume-from-mid-flow contexts.
 *   Callers who want to bake in elapsed time (e.g. the resume tool, which may
 *   arrive well into the grant's lifetime) should reduce `expires_in_seconds`
 *   accordingly before calling `pollDeviceToken`. That is the clean, composable
 *   knob. An internal `startAnchor` would be invisible to callers and prone to
 *   subtle misuse.
 *
 * Scope stored in tokens:
 *   We persist `AUTHKIT_SCOPES` (what we requested) rather than the scope field
 *   from the server's token response. The server's `scope` is informational;
 *   for client-side expiry accounting we store exactly what we asked for. This
 *   matches the convention in the legacy `tools/lore_login.ts` which always
 *   persisted the local `SCOPE` constant.
 */

import { z } from 'zod';
import { AUTHKIT_CLIENT_ID, AUTHKIT_SCOPES } from './constants';
import { discoverEndpoints } from './discovery';
import { writeTokens } from './store';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * RFC 8628 §3.5: when the server returns `slow_down`, the client MUST add
 * this many seconds to its polling interval and keep the wider cadence for the
 * remainder of the flow.
 */
const SLOW_DOWN_INCREMENT_SECONDS = 5;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The device-code response from the authorization server. */
export type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  /** Seconds until the device code expires. */
  expires_in: number;
  /** Minimum polling interval in seconds (RFC 8628 §3.2). */
  interval: number;
};

// ---------------------------------------------------------------------------
// Internal schemas
// ---------------------------------------------------------------------------

/**
 * Zod schema for the device-authorization endpoint response.
 *
 * All six fields are required. `expires_in` and `interval` must be positive
 * integers (seconds). Extra fields are silently ignored.
 */
const DeviceCodeResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  verification_uri_complete: z.string().min(1),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
});

/**
 * Schema for the token endpoint's successful response during device-code polling.
 *
 * Matches `RefreshResponseSchema` in `lib/refresh.ts` exactly: all five fields
 * required, `expires_in` is a positive integer. Any server-supplied `expires_at`
 * is ignored; we compute our own from the local clock.
 */
const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string().min(1),
  scope: z.string(),
});

// ---------------------------------------------------------------------------
// Default sleep implementation
// ---------------------------------------------------------------------------

/**
 * Production sleep. Resolves after `ms` milliseconds using `setTimeout`.
 * We do not use `Bun.sleep` so the binary runs identically under Node and Bun
 * for build-time smoke tests.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// initiateDeviceCode
// ---------------------------------------------------------------------------

/**
 * Initiate the device-code authorization flow (RFC 8628 §3.1–3.2).
 *
 * Internally calls `discoverEndpoints()` to obtain the
 * `deviceAuthorizationEndpoint` and `audience`. Callers do not pass endpoint
 * URLs.
 *
 * Posts to `deviceAuthorizationEndpoint` with:
 *   - `client_id`  = AUTHKIT_CLIENT_ID
 *   - `scope`      = AUTHKIT_SCOPES ("openid email profile offline_access")
 *   - `audience`   = discovered audience from PRM (the resource server's identifier)
 *
 * The `audience` parameter is required by WorkOS AuthKit for device-code
 * requests; without it the token would not be scoped to the correct resource.
 *
 * Validates the response with Zod; throws on any HTTP error or schema mismatch.
 * The error message deliberately excludes the response body — it may contain
 * identifiers we don't want in logs.
 *
 * @param opts.fetchImpl  Injected fetch implementation (for tests).
 * @param opts.home       Home directory override (for tests; affects the discovery cache).
 */
export async function initiateDeviceCode(opts?: {
  fetchImpl?: typeof fetch;
  home?: string;
}): Promise<DeviceCodeResponse> {
  const fetchFn = opts?.fetchImpl ?? fetch;
  const home = opts?.home;

  const { deviceAuthorizationEndpoint, audience } = await discoverEndpoints({
    fetchImpl: fetchFn,
    home,
  });

  const body = new URLSearchParams({
    client_id: AUTHKIT_CLIENT_ID,
    scope: AUTHKIT_SCOPES,
    audience,
  }).toString();

  const res = await fetchFn(deviceAuthorizationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    // Truncate the response body to a safe excerpt. The server may echo
    // request fields (client_id, scope) that we don't want surfaced
    // verbatim in error logs. 200 chars is enough for diagnosis.
    const text = await res.text().catch(() => '');
    const excerpt = text.length > 200 ? `${text.slice(0, 200)}...` : text;
    throw new Error(
      `device-code request failed: HTTP ${res.status} ${excerpt}`,
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    // Don't include the parser error or the body — the success-path body
    // contains the device_code we don't want in logs.
    throw new Error(
      `device-code response was not valid JSON (HTTP ${res.status}).`,
    );
  }

  const parsed = DeviceCodeResponseSchema.safeParse(json);
  if (!parsed.success) {
    // Zod issues reference field paths and expected types, not values.
    throw new Error(
      `device-code response failed schema validation: ${parsed.error.message}`,
    );
  }

  return parsed.data;
}

// ---------------------------------------------------------------------------
// pollDeviceToken
// ---------------------------------------------------------------------------

/**
 * Poll the token endpoint until the user completes authorization (RFC 8628 §3.5).
 *
 * Internally calls `discoverEndpoints()` to resolve the token endpoint URL.
 * Callers do not pass endpoint URLs.
 *
 * Polling semantics:
 *   - `authorization_pending` → keep polling at the current interval.
 *   - `slow_down`            → add SLOW_DOWN_INCREMENT_SECONDS (5 s) to the
 *                              interval permanently for the remainder of the flow.
 *   - `expired_token`        → return `{ ok: false, reason: 'expired_token' }`.
 *   - Any other non-2xx      → throw. The thrown message includes only the
 *                              well-known `error` code, NEVER `error_description`
 *                              (which can echo the `device_code` bearer credential).
 *   - Hard cap: stop when `elapsed >= expires_in_seconds * 1000` and return
 *               `expired_token`, even if the server keeps returning `pending`.
 *               The cap protects against a misbehaving server pinning the agent.
 *
 * On success:
 *   - Validates the token response with Zod (same strictness as `lib/refresh.ts`).
 *   - Computes `expires_at = now() + expires_in * 1000` from the local clock.
 *   - Persists tokens via `writeTokens` from `lib/auth/store.ts`.
 *   - Returns `{ ok: true }`.
 *
 * @param opts.device_code        The device_code from `initiateDeviceCode`.
 * @param opts.expires_in_seconds Grant lifetime in seconds (from device-code response).
 * @param opts.interval_seconds   Initial polling interval in seconds.
 * @param opts.fetchImpl          Injected fetch (for tests).
 * @param opts.home               Home directory override (for tests).
 * @param opts.now                Clock function returning epoch ms (for tests).
 * @param opts.sleep              Sleep implementation (for tests; production uses setTimeout).
 */
export async function pollDeviceToken(opts: {
  device_code: string;
  expires_in_seconds: number;
  interval_seconds: number;
  fetchImpl?: typeof fetch;
  home?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<
  | { ok: true }
  | { ok: false; reason: 'expired_token'; message: string }
> {
  const {
    device_code,
    expires_in_seconds,
    interval_seconds,
  } = opts;
  const fetchFn = opts.fetchImpl ?? fetch;
  const home = opts.home;
  const nowFn = opts.now ?? Date.now;
  const sleepFn = opts.sleep ?? defaultSleep;

  const { tokenEndpoint } = await discoverEndpoints({ fetchImpl: fetchFn, home, now: nowFn });

  // Start the hard-cap clock. We take `start` after discovery so that a slow
  // discovery call doesn't eat into the device-code grant window. The device-
  // code response's `expires_in` is measured from the server's mint time, but
  // we have no shared clock; anchoring to local time just after discovery is a
  // safe lower bound — we stop at or before the server's true expiry.
  const start = nowFn();

  // `intervalSeconds` is mutable — `slow_down` widens it permanently.
  let intervalSeconds = interval_seconds;

  while (true) {
    // Hard cap: checked BEFORE sleeping so a cap triggered between the last
    // sleep and the next poll fires immediately without an extra wait.
    // RFC 8628 uses `>=` semantics: equality counts as expired.
    if (nowFn() - start >= expires_in_seconds * 1000) {
      return {
        ok: false,
        reason: 'expired_token',
        message:
          'The device-code expired before the user approved the request. ' +
          'Call `lore_login` again to start a fresh flow.',
      };
    }

    await sleepFn(intervalSeconds * 1000);

    // POST to the token endpoint with the device-code grant.
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code,
      client_id: AUTHKIT_CLIENT_ID,
    }).toString();

    const pollRes = await fetchFn(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (pollRes.ok) {
      // 200 → token pair. Parse, validate, compute expires_at locally, persist.
      let json: unknown;
      try {
        json = await pollRes.json();
      } catch {
        // Don't include body — it contains the access token on the success path.
        throw new Error(
          `device-flow token response was not valid JSON (HTTP ${pollRes.status}).`,
        );
      }

      const parsed = TokenResponseSchema.safeParse(json);
      if (!parsed.success) {
        // Zod issues reference field paths and expected types, not values.
        throw new Error(
          `device-flow token response failed schema validation: ${parsed.error.message}`,
        );
      }

      await writeTokens(
        {
          access_token: parsed.data.access_token,
          refresh_token: parsed.data.refresh_token,
          // Compute locally — never trust a server-supplied expires_at.
          expires_at: nowFn() + parsed.data.expires_in * 1000,
          // Store AUTHKIT_SCOPES (what we requested), not the server's echoed
          // scope field. This matches the legacy pattern and keeps client-side
          // accounting consistent regardless of what the server echoes.
          scope: AUTHKIT_SCOPES,
        },
        home,
      );
      return { ok: true };
    }

    // Non-2xx: read the error code without surfacing error_description.
    //
    // CREDENTIAL LEAK VECTOR: some servers include the `device_code` in
    // `error_description` (e.g. "device_code dev-XYZ is invalid"). We
    // intentionally read ONLY `error`, never `error_description` or the raw
    // body, to prevent the device_code from leaking into thrown Error messages,
    // logs, or any downstream serialization of the Error object.
    let errorCode: string | undefined;
    try {
      const errBody = (await pollRes.json()) as { error?: unknown };
      if (typeof errBody.error === 'string') {
        errorCode = errBody.error;
      }
    } catch {
      // Body is not JSON — errorCode stays undefined, handled below.
    }

    if (errorCode === 'authorization_pending') {
      // User hasn't clicked Allow yet. Keep polling at the current cadence.
      continue;
    }
    if (errorCode === 'slow_down') {
      // RFC 8628 §3.5: permanently widen the polling interval.
      intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS;
      continue;
    }
    if (errorCode === 'expired_token') {
      return {
        ok: false,
        reason: 'expired_token',
        message:
          'The device-code expired before the user approved the request. ' +
          'Call `lore_login` again to start a fresh flow.',
      };
    }

    // Any other error — `invalid_client`, `access_denied`, network-level 5xx
    // with no JSON body — is fatal and propagated. We surface ONLY the
    // well-known `error` code (never `error_description`, never the raw body).
    const safeCode = errorCode ?? '(no body)';
    throw new Error(
      `device-flow poll failed: HTTP ${pollRes.status} ${safeCode}`,
    );
  }
}
