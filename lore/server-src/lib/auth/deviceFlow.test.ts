/**
 * Tests for lib/auth/deviceFlow.ts.
 *
 * All HTTP interactions are mocked via `fetchImpl` injection — no real network
 * calls. On-disk paths use `home` override pointing to a temp directory so
 * tests do not pollute ~/Library/Application Support/.
 *
 * Because both `initiateDeviceCode` and `pollDeviceToken` call
 * `discoverEndpoints()` internally, the injected `fetchImpl` must handle:
 *   1. `${cloudBaseUrl()}/.well-known/oauth-protected-resource`       (PRM)
 *   2. `${TEST_AS}/.well-known/oauth-authorization-server`             (AS metadata)
 *   3. `${TEST_ISSUER}/oauth2/device_authorization`                    (device-code mint)
 *   4. `${TEST_TOKEN_ENDPOINT}`                                        (device-code polling)
 *
 * Tests that want to focus on the device-flow logic (not discovery) prime the
 * on-disk discovery cache in `beforeEach` via `primeDiscoveryCache`, then reset
 * the discovery in-flight slot so the cache is used. Their `fetchImpl` only
 * needs to handle URLs 3 and 4.
 *
 * Acceptance bullets covered:
 *   ✓ initiateDeviceCode: POSTs correct body (client_id, scope, resource)
 *   ✓ initiateDeviceCode: resource from discovery is in the POST body
 *   ✓ initiateDeviceCode: scope is AUTHKIT_SCOPES (not legacy "mcp.read mcp.write")
 *   ✓ initiateDeviceCode: client_id is the registered WorkOS public CLI client
 *   ✓ initiateDeviceCode: validates required fields via Zod (missing field throws)
 *   ✓ pollDeviceToken success: polls until 200, validates token response, writes to store
 *   ✓ pollDeviceToken authorization_pending: retries at the specified interval
 *   ✓ pollDeviceToken slow_down: permanently adds 5s to interval
 *   ✓ pollDeviceToken expired_token (server): returns { ok: false, reason: 'expired_token' }
 *   ✓ pollDeviceToken hard cap: stops when elapsed >= expires_in_seconds * 1000
 *   ✓ Credential leak: device_code never appears in error messages
 *   ✓ Credential leak: error_description not surfaced in thrown errors
 *   ✓ Token write: uses lib/auth/store.ts (readable via readTokens)
 *   ✓ Token write: expires_at = now() + expires_in * 1000 (client-anchored)
 *   ✓ Token write: scope stored as AUTHKIT_SCOPES (not server-echoed scope)
 *   ✓ pollDeviceToken: unknown error code throws with status and code, not description
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initiateDeviceCode, pollDeviceToken } from './deviceFlow';
import { readTokens } from './store';
import { discoverEndpoints, __resetInFlightForTests as __resetDiscoveryInFlightForTests } from './discovery';
import { __resetCloudBaseUrlForTests } from '../cloudBaseUrl';
import { AUTHKIT_CLIENT_ID, AUTHKIT_SCOPES } from './constants';

// ---------------------------------------------------------------------------
// Fixture constants
// ---------------------------------------------------------------------------

const TEST_BASE = 'https://mcp.lore.tanagram.ai';
const TEST_AS = 'https://signin.lore.tanagram.ai';
const TEST_RESOURCE = 'https://api.lore.tanagram.ai';
const TEST_ISSUER = 'https://signin.lore.tanagram.ai';
const TEST_TOKEN_ENDPOINT = `${TEST_ISSUER}/oauth2/token`;
const TEST_DEVICE_ENDPOINT = `${TEST_ISSUER}/oauth2/device_authorization`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-deviceflow-test-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makePrmBody() {
  return {
    resource: TEST_RESOURCE,
    authorization_servers: [TEST_AS],
  };
}

function makeAsBody() {
  return {
    issuer: TEST_ISSUER,
    token_endpoint: TEST_TOKEN_ENDPOINT,
  };
}

function makeDeviceCodeBody(overrides: Record<string, unknown> = {}) {
  return {
    device_code: 'dev-CODE-ABCDEF',
    user_code: 'WXYZ-1234',
    verification_uri: 'https://auth.example.com/device',
    verification_uri_complete: 'https://auth.example.com/device?user_code=WXYZ-1234',
    expires_in: 600,
    interval: 5,
    ...overrides,
  };
}

function makeTokenBody(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'access-NEW',
    refresh_token: 'refresh-NEW',
    expires_in: 3600,
    token_type: 'Bearer',
    scope: AUTHKIT_SCOPES,
    ...overrides,
  };
}

/**
 * Build a fetchImpl that routes by URL. Handles PRM, AS metadata, device
 * authorization, and token endpoints. Pass overrides for any leg you want to
 * customize; the rest return sensible defaults.
 */
function makeRoutingFetch(opts: {
  deviceResponse?: () => Response | Promise<Response>;
  tokenResponse?: () => Response | Promise<Response>;
  prmResponse?: () => Response | Promise<Response>;
  asResponse?: () => Response | Promise<Response>;
  onCall?: (url: string, init?: RequestInit) => void;
}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr =
      typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
    opts.onCall?.(urlStr, init);
    if (urlStr.includes('oauth-protected-resource')) {
      return opts.prmResponse?.() ?? jsonResponse(makePrmBody());
    }
    if (urlStr.includes('oauth-authorization-server')) {
      return opts.asResponse?.() ?? jsonResponse(makeAsBody());
    }
    if (urlStr === TEST_DEVICE_ENDPOINT) {
      return opts.deviceResponse?.() ?? jsonResponse(makeDeviceCodeBody());
    }
    if (urlStr === TEST_TOKEN_ENDPOINT) {
      return opts.tokenResponse?.() ?? jsonResponse(makeTokenBody());
    }
    throw new Error(`Unexpected URL in test fetchImpl: ${urlStr}`);
  }) as unknown as typeof fetch;
}

/**
 * Build a sequenced fetch stub for a single URL. Each entry in `seq` is
 * returned in order; the stub throws if the queue empties unexpectedly.
 *
 * Used for `pollDeviceToken` tests that want fine-grained control over each
 * poll response without having to enumerate all URLs.
 */
function makeSequencedTokenFetch(seq: Array<Response | (() => Response)>): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; body: string | undefined }>;
} {
  const queue = [...seq];
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr =
      typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
    calls.push({ url: urlStr, body: init?.body as string | undefined });
    if (urlStr.includes('oauth-protected-resource')) return jsonResponse(makePrmBody());
    if (urlStr.includes('oauth-authorization-server')) return jsonResponse(makeAsBody());
    if (urlStr === TEST_DEVICE_ENDPOINT) return jsonResponse(makeDeviceCodeBody());
    if (urlStr === TEST_TOKEN_ENDPOINT) {
      const next = queue.shift();
      if (next === undefined) throw new Error('token endpoint queue is empty');
      return typeof next === 'function' ? next() : next;
    }
    throw new Error(`Unexpected URL in test fetchImpl: ${urlStr}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Sleep stub that records awaited ms and resolves synchronously. */
function makeSleep(): { sleep: (ms: number) => Promise<void>; awaited: number[] } {
  const awaited: number[] = [];
  return {
    sleep: async (ms: number) => {
      awaited.push(ms);
    },
    awaited,
  };
}

/**
 * Prime the on-disk discovery cache so tests that only exercise the device-flow
 * logic don't need their fetchImpl to handle PRM/AS URLs.
 */
async function primeDiscoveryCache(home: string): Promise<void> {
  const primeFetch = makeRoutingFetch({});
  const now = () => 1_700_000_000_000;
  await discoverEndpoints({ fetchImpl: primeFetch, home, now });
  __resetDiscoveryInFlightForTests();
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const FIXED_NOW = 1_700_000_000_000;
const fixedNow = () => FIXED_NOW;

let home: string;

beforeEach(async () => {
  home = makeTmpHome();
  __resetDiscoveryInFlightForTests();
  process.env.LORE_MCP_BASE_URL = TEST_BASE;
  __resetCloudBaseUrlForTests();
  await primeDiscoveryCache(home);
});

afterEach(() => {
  rmrf(home);
  delete process.env.LORE_MCP_BASE_URL;
  __resetCloudBaseUrlForTests();
  __resetDiscoveryInFlightForTests();
});

// ---------------------------------------------------------------------------
// initiateDeviceCode
// ---------------------------------------------------------------------------

describe('initiateDeviceCode', () => {
  test('returns the parsed device-code response', async () => {
    const fetchImpl = makeRoutingFetch({
      deviceResponse: () => jsonResponse(makeDeviceCodeBody()),
    });
    const result = await initiateDeviceCode({ fetchImpl, home });
    expect(result.device_code).toBe('dev-CODE-ABCDEF');
    expect(result.user_code).toBe('WXYZ-1234');
    expect(result.verification_uri).toBe('https://auth.example.com/device');
    expect(result.verification_uri_complete).toBe(
      'https://auth.example.com/device?user_code=WXYZ-1234',
    );
    expect(result.expires_in).toBe(600);
    expect(result.interval).toBe(5);
  });

  test('POST body includes client_id = registered WorkOS public CLI client', async () => {
    let capturedBody: string | undefined;
    const fetchImpl = makeRoutingFetch({
      deviceResponse: () => jsonResponse(makeDeviceCodeBody()),
      onCall: (url, init) => {
        if (url === TEST_DEVICE_ENDPOINT) capturedBody = init?.body as string;
      },
    });
    await initiateDeviceCode({ fetchImpl, home });
    const params = new URLSearchParams(capturedBody);
    expect(params.get('client_id')).toBe('client_01KRSDB9SR20N7MB0D9MPS05Q6');
    expect(params.get('client_id')).toBe(AUTHKIT_CLIENT_ID);
    // WorkOS CLI Auth device flow is configured for this public client id;
    // it is intentionally public and safe to commit per RFC 8252 §8.4.
    // See constants.ts for why we're not using the CIMD URL form here.
    expect(params.get('client_id')).toMatch(/^client_/);
    // Must NOT be the legacy pre-AuthKit client id.
    expect(params.get('client_id')).not.toBe('lore-cowork-plugin');
  });

  test('POST body includes scope = AUTHKIT_SCOPES (openid email profile offline_access)', async () => {
    let capturedBody: string | undefined;
    const fetchImpl = makeRoutingFetch({
      deviceResponse: () => jsonResponse(makeDeviceCodeBody()),
      onCall: (url, init) => {
        if (url === TEST_DEVICE_ENDPOINT) capturedBody = init?.body as string;
      },
    });
    await initiateDeviceCode({ fetchImpl, home });
    const params = new URLSearchParams(capturedBody);
    expect(params.get('scope')).toBe(AUTHKIT_SCOPES);
    expect(params.get('scope')).toBe('openid email profile offline_access');
    // Must NOT be the legacy scope.
    expect(params.get('scope')).not.toBe('mcp.read mcp.write');
  });

  test('POST body includes resource from discovery (PRM resource field)', async () => {
    let capturedBody: string | undefined;
    const fetchImpl = makeRoutingFetch({
      deviceResponse: () => jsonResponse(makeDeviceCodeBody()),
      onCall: (url, init) => {
        if (url === TEST_DEVICE_ENDPOINT) capturedBody = init?.body as string;
      },
    });
    await initiateDeviceCode({ fetchImpl, home });
    const params = new URLSearchParams(capturedBody);
    // WorkOS AuthKit uses RFC 8707's `resource` parameter. The value comes
    // from PRM `resource` field = TEST_RESOURCE.
    expect(params.get('resource')).toBe(TEST_RESOURCE);
    expect(params.has('audience')).toBe(false);
  });

  test('POSTs to the discovered device authorization endpoint, not a hardcoded URL', async () => {
    const calledUrls: string[] = [];
    const fetchImpl = makeRoutingFetch({
      deviceResponse: () => jsonResponse(makeDeviceCodeBody()),
      onCall: (url) => calledUrls.push(url),
    });
    await initiateDeviceCode({ fetchImpl, home });
    expect(calledUrls).toContain(TEST_DEVICE_ENDPOINT);
  });

  test('POST uses content-type: application/x-www-form-urlencoded', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = makeRoutingFetch({
      deviceResponse: () => jsonResponse(makeDeviceCodeBody()),
      onCall: (url, init) => {
        if (url === TEST_DEVICE_ENDPOINT) capturedInit = init;
      },
    });
    await initiateDeviceCode({ fetchImpl, home });
    expect(capturedInit?.method).toBe('POST');
    const headers = new Headers(capturedInit?.headers as HeadersInit);
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
  });

  test('throws on HTTP error from device authorization endpoint', async () => {
    const fetchImpl = makeRoutingFetch({
      deviceResponse: () => new Response('server error', { status: 500 }),
    });
    await expect(initiateDeviceCode({ fetchImpl, home })).rejects.toThrow(
      'device-code request failed',
    );
  });

  test('throws on schema-invalid response (missing required field)', async () => {
    // Missing user_code — should fail Zod validation.
    const fetchImpl = makeRoutingFetch({
      deviceResponse: () =>
        jsonResponse({
          device_code: 'dev-CODE',
          // user_code: intentionally missing
          verification_uri: 'https://auth.example.com/device',
          verification_uri_complete: 'https://auth.example.com/device?user_code=WXYZ',
          expires_in: 600,
          interval: 5,
        }),
    });
    await expect(initiateDeviceCode({ fetchImpl, home })).rejects.toThrow(
      'device-code response failed schema validation',
    );
  });

  test('throws on non-positive-integer expires_in', async () => {
    const fetchImpl = makeRoutingFetch({
      deviceResponse: () =>
        jsonResponse(makeDeviceCodeBody({ expires_in: 600.5 })),
    });
    await expect(initiateDeviceCode({ fetchImpl, home })).rejects.toThrow(
      'device-code response failed schema validation',
    );
  });

  test('throws on non-JSON body (HTTP 200)', async () => {
    const fetchImpl = makeRoutingFetch({
      deviceResponse: () => new Response('not json', { status: 200 }),
    });
    await expect(initiateDeviceCode({ fetchImpl, home })).rejects.toThrow(
      'device-code response was not valid JSON',
    );
  });
});

// ---------------------------------------------------------------------------
// pollDeviceToken
// ---------------------------------------------------------------------------

describe('pollDeviceToken', () => {
  test('happy path: authorization_pending then success → writes tokens and returns { ok: true }', async () => {
    const { fetchImpl, calls } = makeSequencedTokenFetch([
      jsonResponse({ error: 'authorization_pending' }, 400),
      jsonResponse(makeTokenBody({ expires_in: 3600 })),
    ]);
    const { sleep, awaited } = makeSleep();

    const result = await pollDeviceToken({
      device_code: 'dev-CODE-ABCDEF',
      expires_in_seconds: 600,
      interval_seconds: 5,
      fetchImpl,
      home,
      now: fixedNow,
      sleep,
    });

    expect(result).toEqual({ ok: true });
    // Two token-endpoint POSTs at 5s each.
    expect(awaited).toEqual([5000, 5000]);
    // Tokens should be persisted.
    const stored = await readTokens(home);
    expect(stored).not.toBeNull();
    expect(stored?.access_token).toBe('access-NEW');
    expect(stored?.refresh_token).toBe('refresh-NEW');
    // expires_at = now() + 3600 * 1000.
    expect(stored?.expires_at).toBe(FIXED_NOW + 3_600_000);
    // scope must be AUTHKIT_SCOPES, not the server-echoed scope.
    expect(stored?.scope).toBe(AUTHKIT_SCOPES);
    // Two calls to the token endpoint (pending + success).
    const tokenCalls = calls.filter((c) => c.url === TEST_TOKEN_ENDPOINT);
    expect(tokenCalls.length).toBe(2);
  });

  test('success: { ok: true } return value contains no credentials', async () => {
    const fetchImpl = makeRoutingFetch({
      tokenResponse: () => jsonResponse(makeTokenBody()),
    });
    const { sleep } = makeSleep();
    const result = await pollDeviceToken({
      device_code: 'dev-CODE-ABCDEF',
      expires_in_seconds: 600,
      interval_seconds: 5,
      fetchImpl,
      home,
      now: fixedNow,
      sleep,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('dev-CODE-ABCDEF');
    expect(serialized).not.toContain('access-NEW');
    expect(serialized).not.toContain('refresh-NEW');
  });

  test('poll POST body: grant_type, device_code, client_id are correct', async () => {
    let capturedBody: string | undefined;
    const fetchImpl = makeRoutingFetch({
      tokenResponse: () => {
        return jsonResponse(makeTokenBody());
      },
      onCall: (url, init) => {
        if (url === TEST_TOKEN_ENDPOINT) capturedBody = init?.body as string;
      },
    });
    const { sleep } = makeSleep();
    await pollDeviceToken({
      device_code: 'dev-CODE-ABCDEF',
      expires_in_seconds: 600,
      interval_seconds: 5,
      fetchImpl,
      home,
      now: fixedNow,
      sleep,
    });
    const params = new URLSearchParams(capturedBody);
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(params.get('device_code')).toBe('dev-CODE-ABCDEF');
    expect(params.get('client_id')).toBe(AUTHKIT_CLIENT_ID);
  });

  test('token scope stored as AUTHKIT_SCOPES even if server echoes different scope', async () => {
    const fetchImpl = makeRoutingFetch({
      tokenResponse: () =>
        jsonResponse(makeTokenBody({ scope: 'some-other-scope' })),
    });
    const { sleep } = makeSleep();
    await pollDeviceToken({
      device_code: 'dev-CODE-ABCDEF',
      expires_in_seconds: 600,
      interval_seconds: 5,
      fetchImpl,
      home,
      now: fixedNow,
      sleep,
    });
    const stored = await readTokens(home);
    // Must be AUTHKIT_SCOPES regardless of what the server returned.
    expect(stored?.scope).toBe(AUTHKIT_SCOPES);
    expect(stored?.scope).not.toBe('some-other-scope');
  });

  test('token response may omit scope; stored scope is still AUTHKIT_SCOPES', async () => {
    const { scope: _scope, ...tokenBodyWithoutScope } = makeTokenBody();
    const fetchImpl = makeRoutingFetch({
      tokenResponse: () => jsonResponse(tokenBodyWithoutScope),
    });
    const { sleep } = makeSleep();

    await pollDeviceToken({
      device_code: 'dev-CODE-ABCDEF',
      expires_in_seconds: 600,
      interval_seconds: 5,
      fetchImpl,
      home,
      now: fixedNow,
      sleep,
    });

    const stored = await readTokens(home);
    expect(stored?.scope).toBe(AUTHKIT_SCOPES);
  });

  test('expires_at is computed as now() + expires_in * 1000 (client-anchored, not server clock)', async () => {
    // Use a fixed now so we can compute the expected expires_at deterministically.
    const now = () => 2_000_000_000_000;
    const fetchImpl = makeRoutingFetch({
      tokenResponse: () => jsonResponse(makeTokenBody({ expires_in: 1800 })),
    });
    const { sleep } = makeSleep();
    await pollDeviceToken({
      device_code: 'dev-CODE-ABCDEF',
      expires_in_seconds: 600,
      interval_seconds: 5,
      fetchImpl,
      home,
      now,
      sleep,
    });
    const stored = await readTokens(home);
    expect(stored?.expires_at).toBe(2_000_000_000_000 + 1800 * 1000);
  });

  test('authorization_pending: retries at the specified interval and eventually succeeds', async () => {
    const { fetchImpl } = makeSequencedTokenFetch([
      jsonResponse({ error: 'authorization_pending' }, 400),
      jsonResponse({ error: 'authorization_pending' }, 400),
      jsonResponse(makeTokenBody()),
    ]);
    const { sleep, awaited } = makeSleep();

    const result = await pollDeviceToken({
      device_code: 'dev-CODE-ABCDEF',
      expires_in_seconds: 600,
      interval_seconds: 7,
      fetchImpl,
      home,
      now: fixedNow,
      sleep,
    });

    expect(result).toEqual({ ok: true });
    // Three iterations, each at 7s.
    expect(awaited).toEqual([7000, 7000, 7000]);
  });

  test('slow_down: adds 5s to the interval permanently on each slow_down response', async () => {
    const { fetchImpl } = makeSequencedTokenFetch([
      jsonResponse({ error: 'authorization_pending' }, 400),
      jsonResponse({ error: 'slow_down' }, 400),
      jsonResponse({ error: 'slow_down' }, 400),
      jsonResponse(makeTokenBody()),
    ]);
    const { sleep, awaited } = makeSleep();

    const result = await pollDeviceToken({
      device_code: 'dev-CODE-ABCDEF',
      expires_in_seconds: 600,
      interval_seconds: 5,
      fetchImpl,
      home,
      now: fixedNow,
      sleep,
    });

    expect(result).toEqual({ ok: true });
    // Iteration cadence (interval starts at 5s):
    //   iter 1: sleep(5000), poll → authorization_pending
    //   iter 2: sleep(5000), poll → slow_down (interval becomes 10)
    //   iter 3: sleep(10000), poll → slow_down (interval becomes 15)
    //   iter 4: sleep(15000), poll → success
    expect(awaited).toEqual([5000, 5000, 10000, 15000]);
  });

  test('slow_down increase is permanent: subsequent pending iterations also use the widened interval', async () => {
    const { fetchImpl } = makeSequencedTokenFetch([
      jsonResponse({ error: 'slow_down' }, 400),
      jsonResponse({ error: 'authorization_pending' }, 400),
      jsonResponse({ error: 'authorization_pending' }, 400),
      jsonResponse(makeTokenBody()),
    ]);
    const { sleep, awaited } = makeSleep();

    await pollDeviceToken({
      device_code: 'dev-CODE-ABCDEF',
      expires_in_seconds: 600,
      interval_seconds: 5,
      fetchImpl,
      home,
      now: fixedNow,
      sleep,
    });

    // After slow_down at iter 1, interval widens to 10.
    // pending at iters 2+3 must also use 10, not revert to 5.
    expect(awaited).toEqual([5000, 10000, 10000, 10000]);
  });

  test('server expired_token: returns { ok: false, reason: "expired_token" }, no tokens written', async () => {
    const fetchImpl = makeRoutingFetch({
      tokenResponse: () => jsonResponse({ error: 'expired_token' }, 400),
    });
    const { sleep } = makeSleep();

    const result = await pollDeviceToken({
      device_code: 'dev-CODE-ABCDEF',
      expires_in_seconds: 600,
      interval_seconds: 5,
      fetchImpl,
      home,
      now: fixedNow,
      sleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('expired_token');
      expect(result.message).toBeTruthy();
    }
    expect(await readTokens(home)).toBeNull();
  });

  test('hard cap: stops when elapsed >= expires_in_seconds * 1000, returns expired_token', async () => {
    // Clock advances 300s per call. With expires_in=600, after 3 iterations
    // elapsed = 600000 >= 600 * 1000 → hard cap triggers.
    let callCount = 0;
    const FIXED_START = 1_700_000_000_000;
    const now = () => {
      // Call 0: start (taken after discovery, before first check)
      // Call 1: top of iter 1 — delta 0 — under
      // Call 2: top of iter 2 — delta 300_000 — under
      // Call 3: top of iter 3 — delta 600_000 — equal → expired
      // Call 4+: top of iter 4+ (write expires_at on success path — won't happen)
      const t = FIXED_START + callCount * 300_000;
      callCount++;
      return t;
    };
    const { fetchImpl } = makeSequencedTokenFetch([
      // Provide enough pending responses so the hard cap, not the server, terminates the loop.
      jsonResponse({ error: 'authorization_pending' }, 400),
      jsonResponse({ error: 'authorization_pending' }, 400),
      jsonResponse({ error: 'authorization_pending' }, 400),
      jsonResponse({ error: 'authorization_pending' }, 400),
    ]);
    const { sleep } = makeSleep();

    const result = await pollDeviceToken({
      device_code: 'dev-CODE-ABCDEF',
      expires_in_seconds: 600,
      interval_seconds: 1,
      fetchImpl,
      home,
      now,
      sleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('expired_token');
    }
    expect(await readTokens(home)).toBeNull();
  });

  test('hard cap at boundary: elapsed == expires_in_seconds * 1000 is treated as expired', async () => {
    // Verify the >= semantics: equality triggers expiry.
    let callCount = 0;
    const FIXED_START = 1_700_000_000_000;
    // expires_in_seconds = 10; clock jumps exactly 10_000 on the third call.
    const now = () => {
      const delta = [0, 0, 10_000, 0];
      const t = FIXED_START + (delta[callCount] ?? 0);
      callCount++;
      return t;
    };
    const { fetchImpl } = makeSequencedTokenFetch([
      jsonResponse({ error: 'authorization_pending' }, 400),
      jsonResponse({ error: 'authorization_pending' }, 400),
    ]);
    const { sleep } = makeSleep();

    const result = await pollDeviceToken({
      device_code: 'dev-CODE-ABCDEF',
      expires_in_seconds: 10,
      interval_seconds: 1,
      fetchImpl,
      home,
      now,
      sleep,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('expired_token');
    }
  });

  test('unknown error code: throws with status and code, not error_description', async () => {
    const fetchImpl = makeRoutingFetch({
      tokenResponse: () =>
        jsonResponse(
          {
            error: 'invalid_client',
            error_description: 'this should not appear in the error message',
          },
          400,
        ),
    });
    const { sleep } = makeSleep();

    let caught: Error | null = null;
    try {
      await pollDeviceToken({
        device_code: 'dev-CODE-ABCDEF',
        expires_in_seconds: 600,
        interval_seconds: 5,
        fetchImpl,
        home,
        now: fixedNow,
        sleep,
      });
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('invalid_client');
    // Must NOT include error_description content.
    expect(caught!.message).not.toContain('this should not appear');
    expect(caught!.message).not.toContain('error_description');
    expect(await readTokens(home)).toBeNull();
  });

  test('credential leak: device_code does not appear in thrown error when error_description echoes it', async () => {
    // Some servers echo the device_code in error_description.
    // Our code must never surface error_description, so the device_code must
    // not appear in any thrown Error message.
    const SECRET_DEVICE_CODE = 'dev-SUPER-SECRET-BEARER-12345';
    const fetchImpl = makeRoutingFetch({
      tokenResponse: () =>
        jsonResponse(
          {
            error: 'invalid_client',
            error_description: `device_code ${SECRET_DEVICE_CODE} is invalid`,
          },
          400,
        ),
    });
    const { sleep } = makeSleep();

    let caught: Error | null = null;
    try {
      await pollDeviceToken({
        device_code: SECRET_DEVICE_CODE,
        expires_in_seconds: 600,
        interval_seconds: 5,
        fetchImpl,
        home,
        now: fixedNow,
        sleep,
      });
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).not.toBeNull();
    // The device_code value must NEVER appear in the thrown error.
    expect(caught!.message).not.toContain(SECRET_DEVICE_CODE);
    expect(caught!.message).toContain('invalid_client');
  });

  test('token validation: throws on schema-invalid 200 response (missing field)', async () => {
    // access_token present but missing refresh_token, expires_in, token_type.
    const fetchImpl = makeRoutingFetch({
      tokenResponse: () => jsonResponse({ access_token: 'access-ONLY' }),
    });
    const { sleep } = makeSleep();

    await expect(
      pollDeviceToken({
        device_code: 'dev-CODE-ABCDEF',
        expires_in_seconds: 600,
        interval_seconds: 5,
        fetchImpl,
        home,
        now: fixedNow,
        sleep,
      }),
    ).rejects.toThrow('device-flow token response failed schema validation');
    // Tokens must NOT be written on schema failure.
    expect(await readTokens(home)).toBeNull();
  });

  test('token validation: throws on non-integer expires_in in token response', async () => {
    const fetchImpl = makeRoutingFetch({
      tokenResponse: () => jsonResponse(makeTokenBody({ expires_in: 3600.5 })),
    });
    const { sleep } = makeSleep();

    await expect(
      pollDeviceToken({
        device_code: 'dev-CODE-ABCDEF',
        expires_in_seconds: 600,
        interval_seconds: 5,
        fetchImpl,
        home,
        now: fixedNow,
        sleep,
      }),
    ).rejects.toThrow('device-flow token response failed schema validation');
    expect(await readTokens(home)).toBeNull();
  });

  test('token validation: throws on non-JSON 200 body, no tokens written', async () => {
    const fetchImpl = makeRoutingFetch({
      tokenResponse: () => new Response('not json', { status: 200 }),
    });
    const { sleep } = makeSleep();

    await expect(
      pollDeviceToken({
        device_code: 'dev-CODE-ABCDEF',
        expires_in_seconds: 600,
        interval_seconds: 5,
        fetchImpl,
        home,
        now: fixedNow,
        sleep,
      }),
    ).rejects.toThrow('device-flow token response was not valid JSON');
    expect(await readTokens(home)).toBeNull();
  });

  test('non-JSON error body: throws with fallback code "(no body)", not a body excerpt', async () => {
    const fetchImpl = makeRoutingFetch({
      tokenResponse: () => new Response('internal server error text', { status: 500 }),
    });
    const { sleep } = makeSleep();

    let caught: Error | null = null;
    try {
      await pollDeviceToken({
        device_code: 'dev-CODE-ABCDEF',
        expires_in_seconds: 600,
        interval_seconds: 5,
        fetchImpl,
        home,
        now: fixedNow,
        sleep,
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('(no body)');
    // Must not echo the raw text body.
    expect(caught!.message).not.toContain('internal server error text');
  });

  test('polls the discovered token endpoint, not a hardcoded URL', async () => {
    const calledUrls: string[] = [];
    const fetchImpl = makeRoutingFetch({
      tokenResponse: () => jsonResponse(makeTokenBody()),
      onCall: (url) => calledUrls.push(url),
    });
    const { sleep } = makeSleep();
    await pollDeviceToken({
      device_code: 'dev-CODE-ABCDEF',
      expires_in_seconds: 600,
      interval_seconds: 5,
      fetchImpl,
      home,
      now: fixedNow,
      sleep,
    });
    expect(calledUrls).toContain(TEST_TOKEN_ENDPOINT);
    // Must not hit any legacy hardcoded path like /oauth/token.
    const legacyHits = calledUrls.filter(
      (u) => u.endsWith('/oauth/token') && !u.includes('oauth2'),
    );
    expect(legacyHits).toHaveLength(0);
  });
});
