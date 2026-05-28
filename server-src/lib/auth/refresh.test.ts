/**
 * Tests for lib/auth/refresh.ts.
 *
 * All HTTP interactions are mocked via `fetchImpl` injection — no real
 * network calls. On-disk paths use `home` override pointing to a temp
 * directory so tests do not pollute ~/Library/Application Support/.
 *
 * The new refresh path calls `discoverEndpoints()` before posting to the
 * token endpoint, so a test's injected `fetchImpl` must handle THREE
 * distinct URLs in the expired-token path:
 *   1. `${cloudBaseUrl()}/.well-known/oauth-protected-resource/mcp` (PRM)
 *   2. `https://signin.lore.tanagram.ai/.well-known/oauth-authorization-server` (AS metadata)
 *   3. `https://signin.lore.tanagram.ai/oauth2/token`             (token endpoint)
 *
 * Tests that only care about the refresh path (not discovery) prime the
 * on-disk discovery cache once in beforeEach via a dedicated `primeFetch`
 * call to `discoverEndpoints`. This keeps those tests focused — the
 * `fetchImpl` they pass to `getValidAccessToken` only has to handle the
 * token endpoint URL.
 *
 * Acceptance bullets covered:
 *   ✓ No tokens file → throws AuthRequiredError, no network call
 *   ✓ Fresh token → returns it, no network call
 *   ✓ Boundary: expires_at - now == 30_000 → refreshes
 *   ✓ Clearly expired → refreshes
 *   ✓ Refresh POSTs to discovered tokenEndpoint with correct body/headers
 *   ✓ client_id == AUTHKIT_CLIENT_ID (new value)
 *   ✓ Persists new tokens; expires_at computed locally (now() + expires_in * 1000)
 *   ✓ Server-supplied expires_at is ignored
 *   ✓ invalid_grant → deletes tokens, throws AuthRequiredError
 *   ✓ Non-invalid_grant 4xx → throws verbatim, tokens preserved
 *   ✓ 5xx → throws verbatim, tokens preserved
 *   ✓ Schema-invalid 200 body → throws, tokens preserved
 *   ✓ Non-integer expires_in → throws, tokens preserved
 *   ✓ Network error → throws verbatim, tokens preserved
 *   ✓ Concurrent callers: exactly 1 POST, all resolve to same token
 *   ✓ Concurrent callers on invalid_grant: all reject, tokens deleted once
 *   ✓ inFlight cleared after success (subsequent call sees fresh token, no POST)
 *   ✓ __resetInFlightForTests clears a leaked inFlight slot
 *   ✓ Discovery failure (PRM 503) propagates without deleting tokens
 *   ✓ Discovery happens BEFORE token POST in the expired-token path
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthRequiredError } from '../errors';
import {
  getValidAccessToken,
  __resetInFlightForTests,
} from './refresh';
import { readTokens, writeTokens, tokensFilePath, type Tokens } from './store';
import { discoverEndpoints, __resetInFlightForTests as __resetDiscoveryInFlightForTests } from './discovery';
import { __resetCloudBaseUrlForTests } from '../cloudBaseUrl';
import { AUTHKIT_CLIENT_ID } from './constants';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-auth-refresh-test-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

const FIXED_NOW = 1_700_000_000_000; // arbitrary epoch ms
const now = () => FIXED_NOW;

// Fixture values matching the production WorkOS AuthKit setup.
const TEST_BASE = 'https://mcp.lore.tanagram.ai';
const TEST_AS = 'https://signin.lore.tanagram.ai';
const TEST_RESOURCE = 'https://api.lore.tanagram.ai';
const TEST_TOKEN_ENDPOINT = 'https://signin.lore.tanagram.ai/oauth2/token';
const TEST_ISSUER = 'https://signin.lore.tanagram.ai';

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

function freshTokens(overrides: Partial<Tokens> = {}): Tokens {
  return {
    access_token: 'access-FRESH',
    refresh_token: 'refresh-FRESH',
    // 10 minutes in the future — well beyond the 30s skew window.
    expires_at: FIXED_NOW + 10 * 60 * 1000,
    scope: 'mcp.read mcp.write',
    ...overrides,
  };
}

function expiredTokens(overrides: Partial<Tokens> = {}): Tokens {
  return {
    access_token: 'access-OLD',
    refresh_token: 'refresh-OLD',
    // Exactly at now (well within 30s window, so we refresh).
    expires_at: FIXED_NOW,
    scope: 'mcp.read mcp.write',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function successRefreshBody(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'access-NEW',
    refresh_token: 'refresh-NEW',
    expires_in: 300,
    token_type: 'Bearer',
    scope: 'mcp.read mcp.write',
    ...overrides,
  };
}

/**
 * Build a fetchImpl that routes by URL, handling all three endpoints in the
 * discovery + refresh path. Callers can override any leg by specifying
 * `tokenResponse`.
 */
function makeFullRoutingFetch(opts: {
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
    if (urlStr === TEST_TOKEN_ENDPOINT) {
      return opts.tokenResponse?.() ?? jsonResponse(successRefreshBody());
    }
    throw new Error(`Unexpected URL in test fetchImpl: ${urlStr}`);
  }) as unknown as typeof fetch;
}

/**
 * Prime the on-disk discovery cache so tests that only want to exercise
 * the refresh path don't need their fetchImpl to handle the PRM/AS URLs.
 */
async function primeDiscoveryCache(home: string): Promise<void> {
  const primeFetch = makeFullRoutingFetch({});
  await discoverEndpoints({ fetchImpl: primeFetch, home, now });
  __resetDiscoveryInFlightForTests();
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let home: string;

beforeEach(async () => {
  home = makeTmpHome();
  __resetInFlightForTests();
  __resetDiscoveryInFlightForTests();
  process.env.LORE_MCP_BASE_URL = TEST_BASE;
  __resetCloudBaseUrlForTests();
  // Prime the discovery cache so most tests only handle the token endpoint.
  await primeDiscoveryCache(home);
});

afterEach(() => {
  rmrf(home);
  delete process.env.LORE_MCP_BASE_URL;
  __resetCloudBaseUrlForTests();
  __resetInFlightForTests();
  __resetDiscoveryInFlightForTests();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getValidAccessToken', () => {
  test('throws AuthRequiredError and makes no network call when tokens file is absent', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse({}, 200);
    }) as unknown as typeof fetch;
    await expect(
      getValidAccessToken({ now, fetchImpl, home }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    expect(calls).toBe(0);
  });

  test('returns the existing access token when expires_at > now + 30_000 (no network call)', async () => {
    // 31 seconds out — just past the threshold.
    const tokens = freshTokens({ expires_at: FIXED_NOW + 31_000 });
    await writeTokens(tokens, home);
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse(successRefreshBody(), 200);
    }) as unknown as typeof fetch;
    const got = await getValidAccessToken({ now, fetchImpl, home });
    expect(got).toBe('access-FRESH');
    expect(calls).toBe(0);
  });

  test('refreshes when expires_at - now exactly equals 30_000 (boundary: refresh)', async () => {
    const tokens = expiredTokens({
      access_token: 'access-OLD',
      expires_at: FIXED_NOW + 30_000,
    });
    await writeTokens(tokens, home);
    let tokenCalls = 0;
    const fetchImpl = makeFullRoutingFetch({
      tokenResponse: () => {
        tokenCalls++;
        return jsonResponse(successRefreshBody());
      },
    });
    const got = await getValidAccessToken({ now, fetchImpl, home });
    expect(got).toBe('access-NEW');
    expect(tokenCalls).toBe(1);
  });

  test('refreshes when expires_at < now (clearly expired)', async () => {
    await writeTokens(expiredTokens({ expires_at: FIXED_NOW - 5_000 }), home);
    let tokenCalls = 0;
    const fetchImpl = makeFullRoutingFetch({
      tokenResponse: () => {
        tokenCalls++;
        return jsonResponse(successRefreshBody());
      },
    });
    const got = await getValidAccessToken({ now, fetchImpl, home });
    expect(got).toBe('access-NEW');
    expect(tokenCalls).toBe(1);
  });

  test('refresh POSTs to the discovered tokenEndpoint with correct body and headers', async () => {
    await writeTokens(expiredTokens(), home);
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = makeFullRoutingFetch({
      tokenResponse: () => jsonResponse(successRefreshBody()),
      onCall: (url, init) => {
        if (url === TEST_TOKEN_ENDPOINT) {
          capturedUrl = url;
          capturedInit = init;
        }
      },
    });
    await getValidAccessToken({ now, fetchImpl, home });

    expect(capturedUrl).toBe(TEST_TOKEN_ENDPOINT);
    expect(capturedInit?.method).toBe('POST');
    const headers = new Headers(capturedInit?.headers as HeadersInit);
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const body = capturedInit?.body;
    expect(typeof body).toBe('string');
    const params = new URLSearchParams(body as string);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('refresh-OLD');
    expect(params.get('client_id')).toBe(AUTHKIT_CLIENT_ID);
  });

  test('client_id in the POST body is the registered WorkOS public CLI client', async () => {
    await writeTokens(expiredTokens(), home);
    let capturedBody: string | undefined;
    const fetchImpl = makeFullRoutingFetch({
      tokenResponse: () => jsonResponse(successRefreshBody()),
      onCall: (url, init) => {
        if (url === TEST_TOKEN_ENDPOINT) capturedBody = init?.body as string;
      },
    });
    await getValidAccessToken({ now, fetchImpl, home });
    const params = new URLSearchParams(capturedBody);
    expect(params.get('client_id')).toBe('client_01KRSDB9SR20N7MB0D9MPS05Q6');
    expect(params.get('client_id')).toBe(AUTHKIT_CLIENT_ID);
    // WorkOS CLI Auth device flow is configured for this public client id;
    // it is intentionally public and safe to commit per RFC 8252 §8.4.
    expect(params.get('client_id')).toMatch(/^client_/);
    // Explicitly verify it is NOT the legacy pre-AuthKit client id.
    expect(params.get('client_id')).not.toBe('lore-cowork-plugin');
  });

  test('persists new tokens after successful refresh with expires_at computed locally', async () => {
    await writeTokens(expiredTokens(), home);
    const fetchImpl = makeFullRoutingFetch({
      tokenResponse: () => jsonResponse(successRefreshBody({ expires_in: 600 })),
    });
    const got = await getValidAccessToken({ now, fetchImpl, home });
    expect(got).toBe('access-NEW');
    const persisted = await readTokens(home);
    expect(persisted).toEqual({
      access_token: 'access-NEW',
      refresh_token: 'refresh-NEW',
      expires_at: FIXED_NOW + 600 * 1000,
      scope: 'mcp.read mcp.write',
    });
  });

  test('successful refresh may omit scope and preserves the existing stored scope', async () => {
    await writeTokens(expiredTokens({ scope: 'openid email profile offline_access' }), home);
    const { scope: _scope, ...refreshBodyWithoutScope } = successRefreshBody({ expires_in: 600 });
    const fetchImpl = makeFullRoutingFetch({
      tokenResponse: () => jsonResponse(refreshBodyWithoutScope),
    });

    const got = await getValidAccessToken({ now, fetchImpl, home });

    expect(got).toBe('access-NEW');
    const persisted = await readTokens(home);
    expect(persisted).toEqual({
      access_token: 'access-NEW',
      refresh_token: 'refresh-NEW',
      expires_at: FIXED_NOW + 600 * 1000,
      scope: 'openid email profile offline_access',
    });
  });

  test('ignores any server-supplied expires_at; only local now() + expires_in counts', async () => {
    await writeTokens(expiredTokens(), home);
    const fetchImpl = makeFullRoutingFetch({
      tokenResponse: () =>
        jsonResponse(
          successRefreshBody({
            expires_in: 300,
            expires_at: 999_999_999_999, // server-supplied, should be ignored
          }),
        ),
    });
    await getValidAccessToken({ now, fetchImpl, home });
    const persisted = await readTokens(home);
    expect(persisted?.expires_at).toBe(FIXED_NOW + 300_000);
  });

  test('invalid_grant response deletes tokens file and throws AuthRequiredError', async () => {
    await writeTokens(expiredTokens(), home);
    const fetchImpl = makeFullRoutingFetch({
      tokenResponse: () =>
        jsonResponse({ error: 'invalid_grant', error_description: 'expired' }, 400),
    });
    await expect(
      getValidAccessToken({ now, fetchImpl, home }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    expect(fs.existsSync(tokensFilePath(home))).toBe(false);
  });

  test('non-invalid_grant 4xx error is thrown verbatim and tokens are preserved', async () => {
    const tokens = expiredTokens();
    await writeTokens(tokens, home);
    const fetchImpl = makeFullRoutingFetch({
      tokenResponse: () => new Response('rate limited', { status: 429 }),
    });
    await expect(
      getValidAccessToken({ now, fetchImpl, home }),
    ).rejects.not.toBeInstanceOf(AuthRequiredError);
    // Tokens file must still be present and unmodified.
    expect(await readTokens(home)).toEqual(tokens);
  });

  test('5xx error is thrown verbatim and tokens are preserved', async () => {
    const tokens = expiredTokens();
    await writeTokens(tokens, home);
    const fetchImpl = makeFullRoutingFetch({
      tokenResponse: () => new Response('boom', { status: 503 }),
    });
    await expect(
      getValidAccessToken({ now, fetchImpl, home }),
    ).rejects.not.toBeInstanceOf(AuthRequiredError);
    expect(await readTokens(home)).toEqual(tokens);
  });

  test('successful 200 with schema-invalid body (missing fields) throws and preserves tokens', async () => {
    const tokens = expiredTokens();
    await writeTokens(tokens, home);
    const fetchImpl = makeFullRoutingFetch({
      tokenResponse: () => jsonResponse({ access_token: 'a' }),
    });
    await expect(
      getValidAccessToken({ now, fetchImpl, home }),
    ).rejects.not.toBeInstanceOf(AuthRequiredError);
    // File must be unchanged.
    expect(await readTokens(home)).toEqual(tokens);
  });

  test('successful 200 with non-integer expires_in throws and preserves tokens', async () => {
    const tokens = expiredTokens();
    await writeTokens(tokens, home);
    const fetchImpl = makeFullRoutingFetch({
      tokenResponse: () => jsonResponse(successRefreshBody({ expires_in: 300.5 })),
    });
    await expect(
      getValidAccessToken({ now, fetchImpl, home }),
    ).rejects.not.toBeInstanceOf(AuthRequiredError);
    expect(await readTokens(home)).toEqual(tokens);
  });

  test('network error on token endpoint is thrown verbatim and tokens are preserved', async () => {
    const tokens = expiredTokens();
    await writeTokens(tokens, home);
    const fetchImpl = makeFullRoutingFetch({
      tokenResponse: () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(
      getValidAccessToken({ now, fetchImpl, home }),
    ).rejects.toThrow('ECONNREFUSED');
    expect(await readTokens(home)).toEqual(tokens);
  });

  test('discovery failure (PRM 503) propagates without deleting the tokens file', async () => {
    // Reset the primed cache so discovery has to run.
    __resetDiscoveryInFlightForTests();
    const tokens = expiredTokens();
    await writeTokens(tokens, home);
    // Wipe the discovery cache so we force a live discovery attempt.
    const cacheDir = path.join(
      home,
      'Library',
      'Application Support',
      'tanagram',
      'lore',
    );
    const cacheFile = path.join(cacheDir, 'discovery-cache.json');
    if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);

    // PRM returns 503 — discovery will fail.
    const fetchImpl = (async (url: string | URL | Request) => {
      const urlStr =
        typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      if (urlStr.includes('oauth-protected-resource')) {
        return new Response('Service Unavailable', { status: 503 });
      }
      return jsonResponse(successRefreshBody());
    }) as unknown as typeof fetch;

    await expect(
      getValidAccessToken({ now, fetchImpl, home }),
    ).rejects.toThrow();
    // Tokens must NOT be deleted — only invalid_grant triggers deletion.
    expect(await readTokens(home)).toEqual(tokens);
  });

  test('discovery is called BEFORE the token POST in the expired-token path', async () => {
    // Reset so discovery runs fresh.
    __resetDiscoveryInFlightForTests();
    const tokens = expiredTokens();
    await writeTokens(tokens, home);
    const cacheDir = path.join(
      home,
      'Library',
      'Application Support',
      'tanagram',
      'lore',
    );
    const cacheFile = path.join(cacheDir, 'discovery-cache.json');
    if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);

    const callOrder: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const urlStr =
        typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      if (urlStr.includes('oauth-protected-resource')) {
        callOrder.push('prm');
        return jsonResponse(makePrmBody());
      }
      if (urlStr.includes('oauth-authorization-server')) {
        callOrder.push('as-metadata');
        return jsonResponse(makeAsBody());
      }
      if (urlStr === TEST_TOKEN_ENDPOINT) {
        callOrder.push('token');
        return jsonResponse(successRefreshBody());
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    }) as unknown as typeof fetch;

    await getValidAccessToken({ now, fetchImpl, home });

    // PRM and AS metadata must both come before the token POST.
    const tokenIdx = callOrder.indexOf('token');
    const prmIdx = callOrder.indexOf('prm');
    const asIdx = callOrder.indexOf('as-metadata');
    expect(prmIdx).toBeGreaterThanOrEqual(0);
    expect(asIdx).toBeGreaterThanOrEqual(0);
    expect(tokenIdx).toBeGreaterThan(prmIdx);
    expect(tokenIdx).toBeGreaterThan(asIdx);
  });

  test('mutex: 10 concurrent calls on expired tokens produce exactly 1 POST and all resolve to the same access token', async () => {
    await writeTokens(expiredTokens(), home);
    let tokenPostCalls = 0;
    // Gate the token fetch on a manually-resolved promise so all 10 callers
    // land in the same await before we let any of them complete.
    let release!: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    // Discovery cache is already primed, so fetchImpl only sees token endpoint.
    const fetchImpl = (async (url: string | URL | Request) => {
      const urlStr =
        typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      if (urlStr === TEST_TOKEN_ENDPOINT) {
        tokenPostCalls++;
        return gate;
      }
      // Discovery is cached; these shouldn't fire. Handle defensively.
      if (urlStr.includes('oauth-protected-resource')) return jsonResponse(makePrmBody());
      if (urlStr.includes('oauth-authorization-server')) return jsonResponse(makeAsBody());
      throw new Error(`Unexpected URL: ${urlStr}`);
    }) as unknown as typeof fetch;

    const promises = Array.from({ length: 10 }, () =>
      getValidAccessToken({ now, fetchImpl, home }),
    );

    // Give the event loop a tick so all 10 callers can hit the inFlight
    // check before we release the gate.
    await new Promise((r) => setTimeout(r, 10));
    release(jsonResponse(successRefreshBody(), 200));

    const results = await Promise.all(promises);
    expect(tokenPostCalls).toBe(1);
    expect(results).toEqual(Array(10).fill('access-NEW'));
  });

  test('mutex error path: 10 concurrent calls all reject with AuthRequiredError; tokens deleted once; inFlight is cleared', async () => {
    await writeTokens(expiredTokens(), home);
    let tokenPostCalls = 0;
    let release!: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchImpl = (async (url: string | URL | Request) => {
      const urlStr =
        typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      if (urlStr === TEST_TOKEN_ENDPOINT) {
        tokenPostCalls++;
        return gate;
      }
      if (urlStr.includes('oauth-protected-resource')) return jsonResponse(makePrmBody());
      if (urlStr.includes('oauth-authorization-server')) return jsonResponse(makeAsBody());
      throw new Error(`Unexpected URL: ${urlStr}`);
    }) as unknown as typeof fetch;

    const promises = Array.from({ length: 10 }, () =>
      getValidAccessToken({ now, fetchImpl, home }),
    );
    await new Promise((r) => setTimeout(r, 10));
    release(jsonResponse({ error: 'invalid_grant' }, 400));

    const settled = await Promise.allSettled(promises);
    expect(tokenPostCalls).toBe(1);
    for (const s of settled) {
      expect(s.status).toBe('rejected');
      if (s.status === 'rejected') {
        expect(s.reason).toBeInstanceOf(AuthRequiredError);
      }
    }
    expect(fs.existsSync(tokensFilePath(home))).toBe(false);

    // inFlight should be cleared: the next call sees the no-tokens
    // path with NO network call.
    let nextCalls = 0;
    const nextFetch = (async () => {
      nextCalls++;
      return jsonResponse({}, 200);
    }) as unknown as typeof fetch;
    await expect(
      getValidAccessToken({ now, fetchImpl: nextFetch, home }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    expect(nextCalls).toBe(0);
  });

  test('inFlight is cleared after a successful refresh (subsequent call sees the fresh token and makes no network call)', async () => {
    await writeTokens(expiredTokens(), home);
    let tokenCalls = 0;
    const fetchImpl = makeFullRoutingFetch({
      tokenResponse: () => {
        tokenCalls++;
        return jsonResponse(successRefreshBody());
      },
    });
    const first = await getValidAccessToken({ now, fetchImpl, home });
    expect(first).toBe('access-NEW');
    expect(tokenCalls).toBe(1);
    // The new token expires at now+300s, well past the 30s window.
    const second = await getValidAccessToken({ now, fetchImpl, home });
    expect(second).toBe('access-NEW');
    expect(tokenCalls).toBe(1);
  });

  test('__resetInFlightForTests clears a leaked inFlight slot between tests', async () => {
    // Simulate a hung inFlight from a prior test.
    await writeTokens(expiredTokens(), home);
    const hungGate = new Promise<Response>(() => {
      // never resolves
    });
    const hungFetch = makeFullRoutingFetch({
      tokenResponse: () => hungGate,
    });
    // Kick off, but do not await.
    const leaked = getValidAccessToken({ now, fetchImpl: hungFetch, home });
    // Tick.
    await new Promise((r) => setTimeout(r, 5));

    // Clear the slot.
    __resetInFlightForTests();

    // A new call with a working fetch should complete normally.
    const workingFetch = makeFullRoutingFetch({
      tokenResponse: () => jsonResponse(successRefreshBody()),
    });
    const got = await getValidAccessToken({ now, fetchImpl: workingFetch, home });
    expect(got).toBe('access-NEW');

    // Silence the leaked promise.
    void leaked;
  });
});
