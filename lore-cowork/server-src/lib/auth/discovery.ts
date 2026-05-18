/**
 * Endpoint discovery via PRM → AS metadata.
 *
 * Why this module exists:
 *   The AuthKit migration moves from hardcoded endpoint URLs to runtime
 *   discovery. Every auth operation (device-code initiation, token polling,
 *   token refresh) needs three values:
 *     - `audience` (for OAuth token requests)
 *     - `deviceAuthorizationEndpoint` (for RFC 8628 device-code initiation)
 *     - `tokenEndpoint` (for device-code polling AND refresh)
 *   All three are derived from the authorization server's published metadata,
 *   not baked into the plugin binary. This means a cloud-side endpoint change
 *   requires no plugin update.
 *
 * Resolution chain (per RFC 8707 / RFC 8414):
 *   1. GET `${cloudBaseUrl()}/.well-known/oauth-protected-resource`
 *      → Protected Resource Metadata (PRM). Extract:
 *        - `resource`             → becomes `audience`
 *        - `authorization_servers[0]` → the AS we'll query next
 *   2. GET `${authorizationServer}/.well-known/oauth-authorization-server`
 *      → AS metadata (RFC 8414). Extract:
 *        - `token_endpoint`
 *        - `issuer`
 *   3. Derive `deviceAuthorizationEndpoint` from the AS issuer:
 *        `${issuer}/oauth2/device_authorization`
 *      WorkOS AuthKit does NOT advertise `device_authorization_endpoint` in
 *      AS metadata even though it supports the grant. The endpoint URL is
 *      fixed by WorkOS convention, so we derive it rather than read it.
 *
 * Why on-disk caching:
 *   PRM + AS metadata are stable across plugin calls. Re-fetching both
 *   documents on every tool call would add ~100ms of latency and burn
 *   unnecessary network/server capacity. The 24-hour TTL matches the
 *   conventional validity window for OAuth server metadata.
 *
 * Cache strategy:
 *   - Cached result valid for 24 hours (DISCOVERY_TTL_MS).
 *   - Re-fetch uses `If-None-Match` with the stored ETag; a 304 refreshes
 *     the TTL without re-parsing AS metadata.
 *   - On network failure, the last-known-good cache is returned if it exists.
 *   - Cache is keyed by `cloudBaseUrl()` — switching environments (e.g.
 *     staging vs prod) invalidates the cached result.
 *
 * Why module-scope in-flight dedup:
 *   Two concurrent callers (e.g. two proxy tools arriving simultaneously with
 *   a cold cache) would both observe a cache miss and both POST to PRM. The
 *   AS metadata call and the cache write that follow would then race.
 *   The `inFlight` mutex guarantees exactly one PRM+AS fetch pair per process
 *   per TTL window, using the same pattern as `lib/refresh.ts`.
 *
 * Constraint: no `await` between the `if (inFlight)` check and the
 * assignment — same reasoning as in refresh.ts. JS is single-threaded
 * between awaits, so no yield = no TOCTOU window.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { cloudBaseUrl } from '../cloudBaseUrl';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * How long a discovered result is considered fresh before we re-validate
 * with the server. 24 hours matches the conventional OAuth metadata TTL.
 */
const DISCOVERY_TTL_MS = 86_400_000; // 24 hours

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The subset of PRM + AS metadata the plugin actually needs. */
export type DiscoveredEndpoints = {
  /** The audience value for OAuth token requests (from PRM `resource` field). */
  audience: string;
  /** AuthKit's RFC 8628 device-authorization endpoint. */
  deviceAuthorizationEndpoint: string;
  /** AuthKit's token endpoint (used for device-code polling AND refresh). */
  tokenEndpoint: string;
};

// ---------------------------------------------------------------------------
// On-disk cache schema
// ---------------------------------------------------------------------------

/**
 * Schema for the cache file written to disk.
 *
 * `baseUrl` is the `cloudBaseUrl()` value at cache-write time. A mismatch
 * between the stored value and the current `cloudBaseUrl()` means the user
 * switched environments; we discard the stale cache and re-fetch.
 *
 * `prmEtag` is optional because not all servers return ETag headers. When
 * present, it is sent as `If-None-Match` on the next PRM request to allow
 * a 304 Not Modified short-circuit.
 */
const DiscoveryCacheSchema = z.object({
  baseUrl: z.string(),
  endpoints: z.object({
    audience: z.string(),
    deviceAuthorizationEndpoint: z.string(),
    tokenEndpoint: z.string(),
  }),
  fetchedAt: z.number(),
  prmEtag: z.string().optional(),
});

type DiscoveryCache = z.infer<typeof DiscoveryCacheSchema>;

// ---------------------------------------------------------------------------
// PRM / AS metadata schemas
// ---------------------------------------------------------------------------

/**
 * We only require the fields we actually use; extra fields are silently
 * ignored (strict mode would break if the server adds new metadata fields).
 */
const PrmSchema = z.object({
  resource: z.string().min(1, '`resource` must be a non-empty string'),
  authorization_servers: z
    .array(z.string())
    .min(1, '`authorization_servers` must contain at least one entry'),
});

const AsMetadataSchema = z.object({
  issuer: z.string().min(1, '`issuer` must be a non-empty string'),
  token_endpoint: z.string().min(1, '`token_endpoint` must be a non-empty string'),
  // We deliberately do NOT read `device_authorization_endpoint` — WorkOS
  // does not advertise it, and we derive it from the issuer instead.
});

// ---------------------------------------------------------------------------
// File path
// ---------------------------------------------------------------------------

/**
 * Absolute path to the discovery cache file.
 *
 * Placed alongside `tokens.json` in the same Application Support directory
 * so both files share the same parent-directory 0700 mode bits without
 * conflicting chmod races.
 */
export function discoveryCacheFilePath(home: string = os.homedir()): string {
  return path.join(
    home,
    'Library',
    'Application Support',
    'tanagram',
    'lore',
    'discovery-cache.json',
  );
}

// ---------------------------------------------------------------------------
// In-flight mutex (mirrors refresh.ts exactly)
// ---------------------------------------------------------------------------

/**
 * Module-scope mutex. Only one PRM+AS discovery fetch pair runs at a time.
 * Concurrent callers join the same promise. Cleared in `.finally`.
 */
let inFlight: Promise<DiscoveredEndpoints> | null = null;

/**
 * Test-only: clear the module-scope `inFlight` slot.
 *
 * Synchronous — must not insert microtask boundaries between the slot
 * clear and the next `discoverEndpoints` call.
 */
export function __resetInFlightForTests(): void {
  inFlight = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover auth endpoints via PRM → AS metadata.
 *
 * See module-level JSDoc for the full resolution chain, caching strategy,
 * and in-flight dedup semantics.
 *
 * @param opts.fetchImpl  Injected fetch implementation (for tests).
 * @param opts.home       Home directory override (for tests; defaults to `os.homedir()`).
 * @param opts.now        Clock function returning epoch ms (for tests; defaults to `Date.now`).
 */
export function discoverEndpoints(opts?: {
  fetchImpl?: typeof fetch;
  home?: string;
  now?: () => number;
}): Promise<DiscoveredEndpoints> {
  // CRITICAL: no `await` between the inFlight check and the assignment.
  // JS is single-threaded between awaits, so as long as we don't yield
  // here, two concurrent callers will deterministically observe the
  // same `inFlight` value and both return the same promise.
  if (inFlight) return inFlight;
  const p = doDiscover(opts ?? {}).finally(() => {
    // Clear in finally — never only in then — so a rejected discovery
    // doesn't leave a dead rejected promise wedged in the slot for
    // every subsequent caller to inherit.
    inFlight = null;
  });
  inFlight = p;
  return p;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function doDiscover(opts: {
  fetchImpl?: typeof fetch;
  home?: string;
  now?: () => number;
}): Promise<DiscoveredEndpoints> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const home = opts.home;
  const nowFn = opts.now ?? Date.now;
  const base = cloudBaseUrl();

  // 1. Try the on-disk cache.
  const cached = await readCache(home);
  if (cached !== null && cached.baseUrl === base) {
    const age = nowFn() - cached.fetchedAt;
    if (age < DISCOVERY_TTL_MS) {
      // Cache is fresh — return immediately without any HTTP.
      return cached.endpoints;
    }
    // Cache is stale — try ETag revalidation.
    const revalidated = await tryRevalidate(cached, base, fetchFn, home, nowFn);
    if (revalidated !== null) {
      return revalidated;
    }
    // ETag revalidation failed or returned a new response — fall through
    // to full re-fetch below (tryRevalidate returns null only when it
    // wants the caller to do a full re-fetch).
  }

  // 2. Full discovery: PRM → AS metadata.
  return fetchAndCache({ cached, base, fetchFn, home, nowFn });
}

/**
 * Try to revalidate the stale cache using the stored ETag.
 *
 * Returns:
 *   - The cached endpoints (with a refreshed TTL on disk) if the server
 *     returns 304.
 *   - `null` if we need to do a full re-fetch (server returned non-304,
 *     or there is no ETag to send, or the request itself failed with a
 *     network error and we should fall back to the stale cache).
 *
 * On network failure during revalidation, returns the stale endpoints
 * directly (last-known-good fallback).
 *
 * On a non-2xx, non-304 response, returns null to trigger a full re-fetch.
 */
async function tryRevalidate(
  cached: DiscoveryCache,
  base: string,
  fetchFn: typeof fetch,
  home: string | undefined,
  nowFn: () => number,
): Promise<DiscoveredEndpoints | null> {
  if (!cached.prmEtag) {
    // No ETag stored — we can't revalidate, fall through to full re-fetch.
    return null;
  }

  const prmUrl = `${base}/.well-known/oauth-protected-resource`;
  let res: Response;
  try {
    res = await fetchFn(prmUrl, {
      headers: { 'If-None-Match': cached.prmEtag },
    });
  } catch {
    // Network failure — return last-known-good.
    return cached.endpoints;
  }

  if (res.status === 304) {
    // Server confirms the cached data is still valid. Refresh the TTL on disk.
    const refreshed: DiscoveryCache = {
      ...cached,
      fetchedAt: nowFn(),
    };
    await writeCache(refreshed, home);
    return cached.endpoints;
  }

  if (!res.ok) {
    // Non-2xx, non-304 — something went wrong server-side. Return
    // last-known-good rather than throwing, because the existing cache
    // is better than nothing for transient server errors.
    return cached.endpoints;
  }

  // 200 response — server sent us a new body. Let the full re-fetch
  // path parse it; signal that by returning null.
  // We don't try to parse it here to avoid duplicating that logic.
  return null;
}

/**
 * Full PRM → AS metadata fetch.
 *
 * On network failure:
 *   - If there is a stale cache (even from the wrong base URL check would
 *     have already caught that), returns it as last-known-good.
 *   - If there is no cache at all, throws an actionable error.
 */
async function fetchAndCache(params: {
  cached: DiscoveryCache | null;
  base: string;
  fetchFn: typeof fetch;
  home: string | undefined;
  nowFn: () => number;
}): Promise<DiscoveredEndpoints> {
  const { cached, base, fetchFn, home, nowFn } = params;

  const prmUrl = `${base}/.well-known/oauth-protected-resource`;

  // --- Step 1: Fetch PRM ---
  let prmRes: Response;
  try {
    prmRes = await fetchFn(prmUrl);
  } catch (err) {
    if (cached !== null) {
      // Last-known-good fallback.
      return cached.endpoints;
    }
    throw new Error(
      `Discovery failed: could not reach ${prmUrl} and no cached endpoints exist. ` +
        `Check your network connection. (${(err as Error).message})`,
    );
  }

  if (!prmRes.ok) {
    if (cached !== null) {
      return cached.endpoints;
    }
    throw new Error(
      `Discovery failed: GET ${prmUrl} returned HTTP ${prmRes.status}. ` +
        `Check that the server is reachable and the base URL is correct.`,
    );
  }

  const prmEtag = prmRes.headers.get('etag') ?? undefined;

  let prmJson: unknown;
  try {
    prmJson = await prmRes.json();
  } catch {
    throw new Error(
      `Discovery failed: GET ${prmUrl} returned non-JSON body.`,
    );
  }

  const prmResult = PrmSchema.safeParse(prmJson);
  if (!prmResult.success) {
    const missing = prmResult.error.issues
      .map((i) => i.path.join('.') || i.message)
      .join(', ');
    throw new Error(
      `Discovery failed: PRM at ${prmUrl} is missing required fields: ${missing}.`,
    );
  }

  const audience = prmResult.data.resource;
  const asUrl = prmResult.data.authorization_servers[0];

  // --- Step 2: Fetch AS metadata ---
  const asMetaUrl = `${asUrl}/.well-known/oauth-authorization-server`;
  let asRes: Response;
  try {
    asRes = await fetchFn(asMetaUrl);
  } catch (err) {
    if (cached !== null) {
      return cached.endpoints;
    }
    throw new Error(
      `Discovery failed: could not reach AS metadata at ${asMetaUrl} and no cached endpoints exist. ` +
        `(${(err as Error).message})`,
    );
  }

  if (!asRes.ok) {
    if (cached !== null) {
      return cached.endpoints;
    }
    throw new Error(
      `Discovery failed: GET ${asMetaUrl} returned HTTP ${asRes.status}.`,
    );
  }

  let asJson: unknown;
  try {
    asJson = await asRes.json();
  } catch {
    throw new Error(
      `Discovery failed: GET ${asMetaUrl} returned non-JSON body.`,
    );
  }

  const asResult = AsMetadataSchema.safeParse(asJson);
  if (!asResult.success) {
    const missing = asResult.error.issues
      .map((i) => i.path.join('.') || i.message)
      .join(', ');
    throw new Error(
      `Discovery failed: AS metadata at ${asMetaUrl} is missing required fields: ${missing}.`,
    );
  }

  const tokenEndpoint = asResult.data.token_endpoint;
  const issuer = asResult.data.issuer;

  // --- Step 3: Derive deviceAuthorizationEndpoint from issuer ---
  // WorkOS AuthKit does NOT advertise `device_authorization_endpoint` in
  // AS metadata. The endpoint URL is fixed by WorkOS convention.
  const deviceAuthorizationEndpoint = `${issuer}/oauth2/device_authorization`;

  const endpoints: DiscoveredEndpoints = {
    audience,
    deviceAuthorizationEndpoint,
    tokenEndpoint,
  };

  // Persist to disk for future calls.
  const newCache: DiscoveryCache = {
    baseUrl: base,
    endpoints,
    fetchedAt: nowFn(),
    prmEtag,
  };
  await writeCache(newCache, home);

  return endpoints;
}

// ---------------------------------------------------------------------------
// Cache I/O
// ---------------------------------------------------------------------------

async function readCache(home: string | undefined): Promise<DiscoveryCache | null> {
  const p = discoveryCacheFilePath(home);
  let raw: string;
  try {
    raw = await fsp.readFile(p, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupted cache — treat as missing and re-fetch.
    return null;
  }
  const result = DiscoveryCacheSchema.safeParse(parsed);
  if (!result.success) {
    // Schema mismatch (e.g. after a format change) — treat as missing.
    return null;
  }
  return result.data;
}

/**
 * Write the discovery cache atomically, using the same temp-rename pattern
 * as `writeTokens` in `store.ts`. Mode is 0600 (the cache file doesn't
 * contain secrets, but matching the tokens.json mode avoids conflicting
 * chmod races on the same parent directory).
 */
async function writeCache(cache: DiscoveryCache, home: string | undefined): Promise<void> {
  const p = discoveryCacheFilePath(home);
  const parent = path.dirname(p);
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
  await fsp.chmod(parent, 0o700);

  const tmp = `${p}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const body = JSON.stringify(cache);
  try {
    const fh = await fsp.open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(body, 'utf8');
      await fh.chmod(0o600);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, p);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
