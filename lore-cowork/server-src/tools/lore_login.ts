/**
 * MCP tool: `lore_login`.
 *
 * Cold-start authentication path for the cloud Lore tools. Drives the
 * RFC 8628 OAuth device-authorization flow end-to-end inside a single
 * blocking tool call:
 *
 *   1. POST `/oauth/device/code` to mint a device_code + user_code pair.
 *   2. `spawn('open', [verification_uri_complete])` so the user lands
 *      directly on the consent screen with the code pre-filled.
 *   3. Poll `/oauth/token` until the user clicks Allow, the cloud
 *      returns `expired_token`, or the local hard cap kicks in.
 *   4. On success, persist tokens via `writeTokens` with an
 *      `expires_at` computed from the local clock (we deliberately
 *      ignore any server-supplied `expires_at` — see `lib/tokens.ts`).
 *
 * Why this is the agent's escape hatch, not a fully automatic flow:
 *   The plugin runs inside a stdio MCP server hosted by Claude Code.
 *   We cannot post a UI; the only sanctioned way to involve the human
 *   is to open a browser tab. When `open` fails (SSH session, no GUI,
 *   sandboxed runtime) we surface the `verification_uri` + `device_code`
 *   so the agent can hand off to `lore_login_resume`, which polls the
 *   same flow from a headless context using a code the user pastes
 *   onto their own device.
 *
 * Why the agent-visible description names `lore_login_resume` literally:
 *   The agent has no other signal that a fallback tool exists. Without
 *   the name in the description, a `browser_open_failed` response
 *   would dead-end the conversation. The literal-name reference is
 *   what lets the agent chain the two tools without prompting.
 *
 * Why polling is sync-blocking (not streaming):
 *   Cowork's JSON-RPC framing does not deliver partial tool results.
 *   We therefore loop in-process until the flow terminates, which is
 *   bounded by the device-code lifetime the server returns. The agent
 *   sees one tool call returning one result, never a stream.
 *
 * Testability:
 *   The pure `runLoreLogin` accepts injected `fetchImpl`, `spawnImpl`,
 *   `now`, `sleep`, and `home`. Tests pass deterministic fakes; the
 *   wrapped `handler` closes over `globalThis.fetch`, `spawnSync` (with
 *   `{stdio: 'ignore'}` to keep stdout reserved for JSON-RPC framing),
 *   `Date.now`, a setTimeout-backed sleeper, and the default home dir.
 *
 * Credential hygiene:
 *   `device_code`, `access_token`, and `refresh_token` are never
 *   written to stderr. On success the return value does not include
 *   the device_code or any token — only `{ok: true}`. On
 *   `browser_open_failed` the device_code is returned (necessary for
 *   `lore_login_resume`) and the user_code is returned so the user
 *   can visually compare against the consent screen.
 */

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { cloudBaseUrl } from '../lib/cloudBaseUrl.js';
import { writeTokens, type Tokens } from '../lib/tokens.js';
import type { ToolDefinition } from '../lib/tool.js';

const CLIENT_ID = 'lore-cowork-plugin';
const SCOPE = 'mcp.read mcp.write';

/**
 * Shape returned by `POST /oauth/device/code`. We accept the full RFC
 * 8628 payload; only the fields we actually use are typed.
 */
type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

/** Successful token-pair from `POST /oauth/token`. */
type TokenPairResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
};

/** Error shape from `POST /oauth/token` during the device-code grant. */
type OAuthErrorResponse = {
  error: string;
  error_description?: string;
};

/**
 * Outcomes of `runLoreLogin`. Modeled as a discriminated union so the
 * tool handler can serialize each variant without ad-hoc branching, and
 * tests can assert the exact return shape per acceptance bullet.
 */
export type LoreLoginResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'browser_open_failed';
      device_code: string;
      user_code: string;
      verification_uri: string;
      message: string;
    }
  | {
      ok: false;
      reason: 'expired_token';
      message: string;
    };

/**
 * Pure core of the device-flow login. Performs no I/O of its own —
 * every external interaction is funneled through the injected dependencies.
 *
 * The polling loop semantics match RFC 8628 §3.5:
 *   - `authorization_pending` → keep polling at the current interval.
 *   - `slow_down` → add 5 seconds to the local interval *for this and
 *      all subsequent waits*, then continue polling.
 *   - `expired_token` → return the typed failure shape.
 *   - 200 with token pair → persist + return `{ok: true}`.
 *   - Anything else (network error, unknown OAuth error) → throw
 *     verbatim. The handler in `index.ts` maps thrown errors to
 *     `McpError` responses.
 *
 * The hard cap is checked at the top of each iteration so even a
 * server that ignores RFC 8628 and keeps responding `authorization_pending`
 * past `expires_in` cannot pin the agent indefinitely. We compute the
 * start time *after* the device-code response so a slow initial POST
 * doesn't eat into the polling window the cloud actually granted.
 */
export async function runLoreLogin(opts: {
  fetchImpl: typeof fetch;
  spawnImpl: (cmd: string, args: string[]) => { status: number | null };
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  home: string;
}): Promise<LoreLoginResult> {
  const { fetchImpl, spawnImpl, now, sleep, home } = opts;
  const base = cloudBaseUrl();

  // Step 1: mint a device_code.
  const deviceCodeBody = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: SCOPE,
  }).toString();
  const deviceCodeRes = await fetchImpl(`${base}/oauth/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: deviceCodeBody,
  });
  if (!deviceCodeRes.ok) {
    // Defensive bound: the response body could echo request fields
    // (client_id, scope) and may in future include identifiers we'd
    // rather not surface verbatim into thrown Error messages. Truncate
    // to a fixed 200-char excerpt so diagnostic value is preserved but
    // any echoed request material is capped.
    const text = await deviceCodeRes.text().catch(() => '');
    const excerpt = text.length > 200 ? `${text.slice(0, 200)}...` : text;
    throw new Error(
      `device-code request failed: ${deviceCodeRes.status} ${excerpt}`,
    );
  }
  const device = (await deviceCodeRes.json()) as DeviceCodeResponse;

  // Anchor the hard-cap *after* the device-code response — the server's
  // `expires_in` is measured from when it minted the code, but we have
  // no shared clock; using the local post-response time is the safe
  // lower bound (we'll always stop at or before the server's expiry).
  const start = now();

  // Step 2: open the browser. spawnImpl is sync-shaped to mirror
  // `spawnSync`; we only care about the exit status.
  const spawnResult = spawnImpl('open', [device.verification_uri_complete]);
  if (spawnResult.status !== 0) {
    return {
      ok: false,
      reason: 'browser_open_failed',
      device_code: device.device_code,
      user_code: device.user_code,
      verification_uri: device.verification_uri,
      message:
        `Could not open a browser tab automatically. Visit ${device.verification_uri} ` +
        `on any device, enter the code ${device.user_code} when prompted, then call ` +
        `\`lore_login_resume\` with this device_code to finish authentication.`,
    };
  }

  // Step 3: delegate to the shared poll loop. The loop handles the hard
  // cap, slow_down/authorization_pending/expired_token branching, and
  // token persistence on success.
  return pollDeviceToken({
    device_code: device.device_code,
    expires_in_seconds: device.expires_in,
    interval_seconds: device.interval,
    fetchImpl,
    now,
    sleep,
    home,
    startAnchor: start,
  });
}

/**
 * Shared device-code poll loop. Encapsulates the RFC 8628 §3.5 polling
 * semantics and token persistence on success, so both `runLoreLogin`
 * (browser auto-open path) and `runLoreLoginResume` (headless fallback)
 * share one implementation of the behaviour that matters for security:
 *   - never echoing `error_description` (which can contain the
 *     `device_code` credential) into thrown Error messages,
 *   - locally-computed `expires_at` (server-supplied times ignored),
 *   - hard-cap so a misbehaving server can't pin the agent.
 *
 * `startAnchor` is an internal escape hatch for `runLoreLogin`, which
 * needs the cap measured from *after* the device-code response (not
 * from the first poll). External callers omit it and the cap starts at
 * the first `now()` inside this function.
 */
export async function pollDeviceToken(opts: {
  device_code: string;
  expires_in_seconds: number;
  interval_seconds: number;
  fetchImpl: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  home: string;
  startAnchor?: number;
}): Promise<
  | { ok: true }
  | { ok: false; reason: 'expired_token'; message: string }
> {
  const {
    device_code,
    expires_in_seconds,
    interval_seconds,
    fetchImpl,
    now,
    sleep,
    home,
  } = opts;
  const start = opts.startAnchor ?? now();
  const tokenUrl = `${cloudBaseUrl()}/oauth/token`;

  // Interval is mutable across iterations because `slow_down`
  // permanently widens it; once the server has asked us to back off,
  // every subsequent wait stays at the wider cadence.
  let intervalSeconds = interval_seconds;
  while (true) {
    // Hard cap: if our local clock says we're past the granted window,
    // bail out before issuing another poll. Equality with
    // `expires_in_seconds * 1000` counts as expired — at that instant
    // the server's grant is already invalid by RFC 8628.
    if (now() - start >= expires_in_seconds * 1000) {
      return {
        ok: false,
        reason: 'expired_token',
        message:
          'The device-code expired before the user approved the request. ' +
          'Call `lore_login` again to start a fresh flow.',
      };
    }

    await sleep(intervalSeconds * 1000);

    const pollBody = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code,
      client_id: CLIENT_ID,
    }).toString();
    const pollRes = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: pollBody,
    });

    if (pollRes.ok) {
      // 200 → token pair. Parse, compute expires_at locally, persist,
      // return success without leaking either token in the return value.
      const pair = (await pollRes.json()) as TokenPairResponse;
      const tokens: Tokens = {
        access_token: pair.access_token,
        refresh_token: pair.refresh_token,
        expires_at: now() + pair.expires_in * 1000,
        scope: SCOPE,
      };
      await writeTokens(tokens, home);
      return { ok: true };
    }

    // Non-2xx: must be a recognised OAuth error or we propagate.
    const errBody = (await pollRes.json().catch(() => null)) as
      | OAuthErrorResponse
      | null;
    const code = errBody?.error;
    if (code === 'authorization_pending') {
      // User hasn't clicked Allow yet. Keep polling at current cadence.
      continue;
    }
    if (code === 'slow_down') {
      // RFC 8628 §3.5: add 5s to the polling interval for the remainder
      // of the flow.
      intervalSeconds += 5;
      continue;
    }
    if (code === 'expired_token') {
      return {
        ok: false,
        reason: 'expired_token',
        message:
          'The device-code expired before the user approved the request. ' +
          'Call `lore_login` again to start a fresh flow.',
      };
    }
    // Anything else — `invalid_client`, `access_denied`, network-level
    // 5xx with no JSON body — is fatal and propagated.
    //
    // Credential-leak vector being closed: the server's
    // `error_description` field for some failure modes echoes the
    // submitted `device_code` (e.g. "device_code dev-XYZ is invalid").
    // `device_code` is a bearer credential until it expires, so we
    // surface ONLY the well-known `error` code here — never the
    // `error_description` and never the raw body — to avoid leaking
    // the device_code into thrown Error messages, logs, or anywhere
    // downstream that serializes the Error.
    const safeCode = code ?? '(no body)';
    throw new Error(
      `device-flow poll failed: ${pollRes.status} ${safeCode}`,
    );
  }
}

/**
 * Default sleeper for the production handler. Resolves after `ms`
 * milliseconds using `setTimeout`. We do not use `Bun.sleep` here so
 * that the binary runs identically under Node and Bun for build-time
 * smoke tests.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const loreLoginTool: ToolDefinition = {
  name: 'lore_login',
  description:
    'Authenticate to Lore via device flow. Call this tool when other Lore tools return an auth-required error. ' +
    'A browser tab will open at the Lore consent screen with the device code pre-filled; the tool blocks ' +
    'until the user approves or the device code expires. If the browser cannot be opened automatically ' +
    '(e.g. SSH or headless environments), the tool returns a `browser_open_failed` result containing the ' +
    'verification URL and device code — in that case, instruct the user to visit the URL on any device and ' +
    'then call `lore_login_resume` with the returned `device_code` to finish authentication.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  handler: async (): Promise<LoreLoginResult> => {
    return runLoreLogin({
      fetchImpl: globalThis.fetch,
      spawnImpl: (cmd, args) => {
        const r = spawnSync(cmd, args, { stdio: 'ignore' });
        return { status: r.status };
      },
      now: Date.now,
      sleep: defaultSleep,
      home: os.homedir(),
    });
  },
};
