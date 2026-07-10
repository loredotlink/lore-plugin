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

import fs from 'node:fs';
import {
  OAuthInvalidGrantError,
  OAuthNoAuthorizationServerError,
  readClientTokens,
  refreshLockDirPath,
  refreshOAuthTokens,
  tokenEndpointFromAccessTokenIssuer,
  withTokenRefreshLock,
} from '@lore/identity-store';
import { AuthRequiredError } from '../errors';
import { readTokens, writeTokens, deleteTokens, stateDir, type Tokens } from './store';
import { discoverEndpoints } from './discovery';
import { PLUGIN_AUTHKIT_CLIENT_ID } from './constants';

/**
 * Refresh window: refresh if the access token expires within 30s.
 * Deliberately not parameterized — the spec is fixed and call sites
 * should never have a reason to tune it.
 */
const REFRESH_SKEW_MS = 30_000;
const TRUTHY_TOKEN_ENV = new Set(['1', 'true', 'yes', 'on']);
const DESKTOP_MANAGED_CLIENT_KEY = 'desktop' as const;

/**
 * The module-scope mutex. Exactly one concurrent refresh per process.
 * Tests can clear it via `__resetInFlightForTests`.
 */
let inFlight: Promise<string> | null = null;
let activeRefreshLockStateDir: string | null = null;

interface Options {
  now?: () => number;
  fetchImpl?: typeof fetch;
  home?: string;
}

function isExternallyManagedTokenMode(): boolean {
  const value = process.env.LORE_EXTERNAL_TOKEN_MANAGER;
  return typeof value === 'string' && TRUTHY_TOKEN_ENV.has(value.trim().toLowerCase());
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

  if (isExternallyManagedTokenMode()) {
    const tokens = await readClientTokens(stateDir(home), DESKTOP_MANAGED_CLIENT_KEY);
    if (tokens === null) {
      throw new AuthRequiredError();
    }
    return tokens.access_token;
  }

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

  const lockStateDir = stateDir(home);
  activeRefreshLockStateDir = lockStateDir;
  return withTokenRefreshLock(lockStateDir, async () => {
    const latest = await readTokens(home);
    if (latest === null) {
      throw new AuthRequiredError();
    }

    const latestRemaining = latest.expires_at - nowFn();
    if (latestRemaining > REFRESH_SKEW_MS) {
      return latest.access_token;
    }

    return refreshAndPersist(latest, nowFn, fetchFn, home);
  });
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
  let tokenEndpoint: string;
  try {
    ({ tokenEndpoint } = await discoverEndpoints({ fetchImpl: fetchFn, home, now: nowFn }));
  } catch (error) {
    if (!(error instanceof OAuthNoAuthorizationServerError)) throw error;
    const fallback = tokenEndpointFromAccessTokenIssuer(current.access_token);
    if (fallback === null) throw error;
    tokenEndpoint = fallback;
  }
  try {
    const updated = await refreshOAuthTokens({
      current,
      tokenEndpoint,
      clientId: PLUGIN_AUTHKIT_CLIENT_ID,
      fetchImpl: fetchFn,
      now: nowFn,
    });
    await writeTokens(updated, home);
    return updated.access_token;
  } catch (error) {
    if (error instanceof OAuthInvalidGrantError) {
      await deleteTokens(home);
      throw new AuthRequiredError();
    }
    throw error;
  }
}

/**
 * Force a token refresh in response to a cloud 401, then return the resulting
 * access token. Used by `cloudCall`'s retry-before-delete path.
 *
 * Why this exists separately from `getValidAccessToken`:
 *   `getValidAccessToken` returns the current token untouched while it still
 *   has >30s of life. But a cloud 401 can arrive on a locally-"valid" token —
 *   the access token was revoked/expired server-side, or another client
 *   rotated the session. In that case we must redeem regardless of local
 *   expiry, which the normal path deliberately won't do.
 *
 * Concurrency: runs under the same cross-process refresh lock as the normal
 * path. Inside the lock we re-read the on-disk tokens; if another process (or
 * client) already rotated to a different access token after our 401, we adopt
 * that token instead of redeeming again — redeeming would double-spend the
 * single-use refresh token the winner just consumed. Only when the on-disk
 * token still matches the one that just failed do we actually redeem.
 *
 * Error contract mirrors `refreshAndPersist`: a dead refresh token
 * (`invalid_grant`/`invalid_refresh_token`) deletes the tokens and throws
 * `AuthRequiredError`; a transient failure (5xx/network/timeout) throws
 * verbatim and preserves the tokens so the caller can retry later.
 */
export async function forceRefreshAccessToken(opts: {
  previousAccessToken: string;
  home?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<string> {
  const nowFn = opts.now ?? Date.now;
  const fetchFn = opts.fetchImpl ?? fetch;
  const home = opts.home;

  if (isExternallyManagedTokenMode()) {
    // The desktop app owns refresh for its slot; we cannot redeem it here.
    // Adopt a rotated token if the desktop already refreshed, else surface
    // auth-required rather than risk invalidating the desktop's session.
    const tokens = await readClientTokens(stateDir(home), DESKTOP_MANAGED_CLIENT_KEY);
    if (tokens === null || tokens.access_token === opts.previousAccessToken) {
      throw new AuthRequiredError();
    }
    return tokens.access_token;
  }

  const lockStateDir = stateDir(home);
  activeRefreshLockStateDir = lockStateDir;
  return withTokenRefreshLock(lockStateDir, async () => {
    const latest = await readTokens(home);
    if (latest === null) {
      throw new AuthRequiredError();
    }
    // Another process may have rotated the token between our failed call and
    // acquiring the lock. Adopt it rather than double-spending the refresh.
    if (latest.access_token !== opts.previousAccessToken) {
      return latest.access_token;
    }
    return refreshAndPersist(latest, nowFn, fetchFn, home);
  });
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
  if (activeRefreshLockStateDir !== null) {
    fs.rmSync(refreshLockDirPath(activeRefreshLockStateDir), { recursive: true, force: true });
    activeRefreshLockStateDir = null;
  }
}
