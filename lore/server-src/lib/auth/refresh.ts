/**
 * Single chokepoint for "get me a usable access token right now".
 *
 * Why this module exists:
 *   Every cloud-proxy tool (share_session, get_thread, etc.) needs an
 *   access token bearer string before it can hit the cloud MCP. Naive
 *   approach: each tool reads `tokens.json`, checks expiry, refreshes
 *   if needed. The problem is concurrency: two tool calls landing at
 *   the same time would both observe an expired token, both POST to
 *   the token endpoint, and the SECOND refresh would invalidate the
 *   first (the cloud rotates refresh tokens, so one refresh-token can
 *   only be redeemed once). The second tool call would then succeed but
 *   permanently corrupt the on-disk refresh token for any third call.
 *
 *   `getValidAccessToken()` solves this with a module-scope `inFlight`
 *   promise. Whichever caller arrives first kicks off `doGet`; every
 *   subsequent caller during that window joins the same promise. The
 *   `.finally` clears the slot regardless of resolution — a rejected
 *   refresh does not poison future callers.
 *
 * Why the 30s skew window:
 *   Even if the local clock and the cloud's clock differ by a few
 *   hundred milliseconds, refreshing 30 seconds before the server's
 *   stated expiry means in-flight requests with the OLD token can
 *   still land successfully. Anything tighter risks the cloud
 *   rejecting a request that left here as "valid".
 *
 * Why we compute `expires_at` locally, not from the server response:
 *   The cloud returns `expires_in` (seconds) in the refresh body. The
 *   server's own `expires_at`, if present, is anchored to the server's
 *   clock — our refresh logic is anchored to the client's clock. Mixing
 *   the two would mean a client/server clock skew could push the
 *   refresh window past expiry. By writing `now() + expires_in*1000`
 *   we bound skew to whatever the local clock drifted while the
 *   request was in flight.
 *
 * Why the token endpoint URL comes from discovery:
 *   The legacy refresh.ts hardcodes `${cloudBaseUrl()}/oauth/token`. The
 *   AuthKit migration resolves the endpoint at runtime via
 *   `discoverEndpoints().tokenEndpoint`. This means a cloud-side endpoint
 *   change requires no plugin update. Discovery results are cached on
 *   disk (24-hour TTL), so the per-call cost is typically zero.
 *
 * Constraints intentionally enforced:
 *   - `inFlight` is module-scope. No class, no singleton object.
 *   - No `await` between the `if (inFlight)` check and the assignment.
 *     Inserting one opens a TOCTOU window where two callers could both
 *     start their own `doGet`.
 *   - `.finally`, never `.then`, to clear the slot — rejection must
 *     reset just like resolution.
 *   - No `import` from `../cloudCall`. That direction is reversed; this
 *     module is a leaf.
 *   - Discovery failure does NOT delete the tokens file. Only
 *     `invalid_grant` triggers deletion.
 */

import { z } from 'zod';
import { AuthRequiredError } from '../errors';
import { readTokens, writeTokens, deleteTokens, type Tokens } from './store';
import { discoverEndpoints } from './discovery';
import { AUTHKIT_CLIENT_ID } from './constants';

/**
 * Refresh window: refresh if the access token expires within 30s.
 * Deliberately not parameterized — the spec is fixed and call sites
 * should never have a reason to tune it.
 */
const REFRESH_SKEW_MS = 30_000;

/**
 * Schema for the cloud's successful refresh response.
 *
 * All five fields are required. `expires_in` must be a positive integer
 * (seconds) — a float here usually means someone confused seconds with
 * milliseconds upstream, and we'd rather fail loud than silently
 * truncate to a window that expires in the past.
 *
 * We intentionally do NOT model server-provided `expires_at` even if
 * one appears: the plugin computes its own from `now() + expires_in *
 * 1000`. Any extra fields the server includes are ignored.
 */
const RefreshResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string().min(1),
  scope: z.string(),
});

type RefreshResponse = z.infer<typeof RefreshResponseSchema>;

/**
 * The module-scope mutex. Exactly one concurrent refresh per process.
 * Tests can clear it via `__resetInFlightForTests`.
 */
let inFlight: Promise<string> | null = null;

interface Options {
  now?: () => number;
  fetchImpl?: typeof fetch;
  home?: string;
}

/**
 * Return a valid access token, refreshing if the current one is within
 * 30s of expiry. Concurrent callers share one in-flight refresh.
 *
 * Throws `AuthRequiredError` when:
 *   - No tokens file exists.
 *   - The cloud responds `invalid_grant` (refresh token revoked or
 *     expired). The tokens file is deleted in that case so the next
 *     call cleanly surfaces "must log in again".
 *
 * Throws other errors verbatim — network failures, 5xx responses,
 * schema mismatches, non-`invalid_grant` 4xx — because those don't
 * indicate the user needs to re-authenticate. The agent should retry
 * or surface the error, not prompt for login.
 */
export function getValidAccessToken(opts: Options = {}): Promise<string> {
  // CRITICAL: no `await` between the inFlight check and the assignment.
  // JS is single-threaded between awaits, so as long as we don't yield
  // here, two concurrent callers will deterministically observe the
  // same `inFlight` value.
  if (inFlight) return inFlight;
  const p = doGet(opts).finally(() => {
    // Clear in finally — never only in then — so a rejected refresh
    // doesn't leave a dead rejected promise wedged in the slot for
    // every subsequent caller to inherit.
    inFlight = null;
  });
  inFlight = p;
  return p;
}

async function doGet(opts: Options): Promise<string> {
  const nowFn = opts.now ?? Date.now;
  const fetchFn = opts.fetchImpl ?? fetch;
  const home = opts.home;

  const tokens = await readTokens(home);
  if (tokens === null) {
    throw new AuthRequiredError();
  }

  // Refresh if the access token expires within REFRESH_SKEW_MS, i.e.
  // `expires_at - now <= REFRESH_SKEW_MS`. Equivalently: keep using
  // the existing token only when `expires_at - now > REFRESH_SKEW_MS`.
  const remaining = tokens.expires_at - nowFn();
  if (remaining > REFRESH_SKEW_MS) {
    return tokens.access_token;
  }

  return refreshAndPersist(tokens, nowFn, fetchFn, home);
}

async function refreshAndPersist(
  current: Tokens,
  nowFn: () => number,
  fetchFn: typeof fetch,
  home: string | undefined,
): Promise<string> {
  // Resolve the token endpoint via discovery BEFORE attempting the POST.
  // Discovery results are cached on disk (24h TTL), so this is typically
  // a fast read. If discovery itself fails (network error, 5xx on PRM),
  // the error propagates as-is WITHOUT deleting the tokens file — the
  // user's refresh token is still valid and the failure is transient.
  const { tokenEndpoint } = await discoverEndpoints({ fetchImpl: fetchFn, home, now: nowFn });

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refresh_token,
    client_id: AUTHKIT_CLIENT_ID,
  }).toString();

  const res = await fetchFn(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    // Try to read the body as JSON to detect `invalid_grant`. If the
    // body isn't JSON or doesn't contain an `error` field, we treat
    // this as a generic transient failure and rethrow without touching
    // the tokens file. The user's refresh token is preserved across
    // 429s, 503s, intermittent network blips, etc.
    let parsedError: { error?: unknown } | undefined;
    try {
      parsedError = (await res.json()) as { error?: unknown };
    } catch {
      parsedError = undefined;
    }
    if (parsedError && parsedError.error === 'invalid_grant') {
      // Refresh token is dead. Wipe the file so the next call lands on
      // the "no tokens" path (which throws AuthRequiredError cleanly)
      // and the agent can call lore_login.
      await deleteTokens(home);
      throw new AuthRequiredError();
    }
    // Other 4xx / 5xx: leave the tokens file alone and surface the
    // failure. Include the status so the agent log is legible; do NOT
    // include the response body (could contain echoed credentials).
    throw new Error(
      `Cloud refresh failed with HTTP ${res.status}; tokens preserved for retry.`,
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    // Do NOT include the parser error message: some JSON parsers echo a
    // snippet of the offending input, and on the success path the body
    // contains an access token. Status alone is enough for diagnosis.
    throw new Error(
      `Cloud refresh response was not valid JSON (HTTP ${res.status}).`,
    );
  }
  const parsed = RefreshResponseSchema.safeParse(json);
  if (!parsed.success) {
    // Zod issues reference field paths and expected types, but not
    // the failing values themselves, so this message can safely be
    // surfaced upward. We do not include the raw response body —
    // it contains an access token on the success path.
    throw new Error(
      `Cloud refresh response failed schema validation: ${parsed.error.message}`,
    );
  }

  const fresh: RefreshResponse = parsed.data;
  const updated: Tokens = {
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token,
    // Compute locally — never trust a server-supplied expires_at.
    expires_at: nowFn() + fresh.expires_in * 1000,
    scope: fresh.scope,
  };
  await writeTokens(updated, home);
  return updated.access_token;
}

/**
 * Test-only: clear the module-scope `inFlight` slot.
 *
 * Tests call this in `beforeEach` to guarantee a clean start, and after
 * any test that intentionally leaks a never-resolving fetch so the next
 * test isn't stuck awaiting the dead promise.
 *
 * Synchronous — must not insert microtask boundaries between the slot
 * clear and the next `getValidAccessToken` call.
 */
export function __resetInFlightForTests(): void {
  inFlight = null;
}
