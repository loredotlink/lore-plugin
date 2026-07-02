/**
 * Tests for lib/auth/discovery.ts.
 *
 * All HTTP interactions are mocked via `fetchImpl` injection — no real
 * network calls. On-disk cache paths use `home` override pointing to a
 * temp directory so tests do not pollute the canonical ~/.lore state dir.
 *
 * Acceptance bullets covered (see task description for canonical list):
 *   ✓ Happy path: PRM at the MCP resource path → AS metadata → returns all three fields
 *   ✓ Cache hit: second call within 24h returns cached data, no HTTP
 *   ✓ ETag revalidation: expired cache sends If-None-Match; 304 refreshes TTL
 *   ✓ Network failure with stale cache: returns last-known-good
 *   ✓ Network failure with no cache: throws naming "discovery" and the URL
 *   ✓ Different cloudBaseUrl() invalidates cache
 *   ✓ Missing PRM fields throw with field name
 *   ✓ Missing AS metadata fields throw with field name
 *   ✓ Concurrent callers dedupe to one PRM+AS fetch pair
 *   ✓ deviceAuthorizationEndpoint derived as ${issuer}/oauth2/device_authorization
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverEndpoints,
  discoveryCacheFilePath,
  __resetInFlightForTests,
} from './discovery';
import { __resetCloudBaseUrlForTests } from '../cloudBaseUrl';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-discovery-test-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Epoch ms fixed for clock injection. */
const FIXED_NOW = 1_748_000_000_000;
const now = () => FIXED_NOW;

/** 25 hours after FIXED_NOW — beyond the 24h TTL. */
const STALE_NOW = () => FIXED_NOW + 25 * 60 * 60 * 1000;

/** 23 hours after FIXED_NOW — still fresh. */
const FRESH_NOW = () => FIXED_NOW + 23 * 60 * 60 * 1000;

// Production-like fixture values (match the live server as of plan date).
const TEST_BASE = 'https://mcp.lore.tanagram.ai';
const TEST_AS = 'https://signin.lore.tanagram.ai';
const TEST_RESOURCE = 'https://mcp.lore.tanagram.ai/mcp';
const TEST_PRM_URL = 'https://mcp.lore.tanagram.ai/.well-known/oauth-protected-resource/mcp';
const TEST_TOKEN_ENDPOINT = 'https://signin.lore.tanagram.ai/oauth2/token';
const TEST_ISSUER = 'https://signin.lore.tanagram.ai';
const TEST_DEVICE_AUTH_ENDPOINT = `${TEST_ISSUER}/oauth2/device_authorization`;

function makePrmBody(overrides?: Partial<{ resource: string; authorization_servers: string[] }>) {
  return {
    resource: TEST_RESOURCE,
    authorization_servers: [TEST_AS],
    bearer_methods_supported: ['header'],
    ...overrides,
  };
}

function makeAsBody(overrides?: Partial<{ issuer: string; token_endpoint: string }>) {
  return {
    issuer: TEST_ISSUER,
    token_endpoint: TEST_TOKEN_ENDPOINT,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * Build a fetchImpl that serves PRM then AS metadata in order.
 * Captures each call for later inspection.
 */
function makeTwoStepFetch(
  prmBody: unknown = makePrmBody(),
  asBody: unknown = makeAsBody(),
  prmHeaders?: Record<string, string>,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    calls.push({ url: urlStr, init });
    if (urlStr.includes('oauth-protected-resource')) {
      return jsonResponse(prmBody, 200, prmHeaders);
    }
    if (urlStr.includes('oauth-authorization-server')) {
      return jsonResponse(asBody);
    }
    throw new Error(`Unexpected URL: ${urlStr}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let home: string;

beforeEach(() => {
  home = makeTmpHome();
  __resetInFlightForTests();
  process.env.LORE_MCP_BASE_URL = TEST_BASE;
  delete process.env.LORE_PLUGIN_STATE_DIR;
  delete process.env.LORE_DEV_STATE_DIR;
  __resetCloudBaseUrlForTests();
});

afterEach(() => {
  rmrf(home);
  delete process.env.LORE_MCP_BASE_URL;
  delete process.env.LORE_PLUGIN_STATE_DIR;
  delete process.env.LORE_DEV_STATE_DIR;
  __resetCloudBaseUrlForTests();
  __resetInFlightForTests();
});

// ---------------------------------------------------------------------------
// discoveryCacheFilePath
// ---------------------------------------------------------------------------

describe('discoveryCacheFilePath', () => {
  test('returns path alongside the canonical ~/.lore tokens.json', () => {
    const h = '/Users/test';
    expect(discoveryCacheFilePath(h)).toBe('/Users/test/.lore/discovery-cache.json');
  });

  test('honors explicit dev state dir override', () => {
    process.env.LORE_DEV_STATE_DIR = '~/custom-lore-dev-state';
    expect(discoveryCacheFilePath('/Users/test')).toBe('/Users/test/custom-lore-dev-state/discovery-cache.json');
  });

  test('installed plugin state dir takes precedence over dev state dir override', () => {
    process.env.LORE_DEV_STATE_DIR = '~/custom-lore-dev-state';
    process.env.LORE_PLUGIN_STATE_DIR = '~/installed-lore-plugin-state';
    expect(discoveryCacheFilePath('/Users/test')).toBe('/Users/test/installed-lore-plugin-state/discovery-cache.json');
  });

  test('defaults to os.homedir() when no override is passed', () => {
    const expected = path.join(os.homedir(), '.lore', 'discovery-cache.json');
    expect(discoveryCacheFilePath()).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('happy path', () => {
  test('fetches PRM then AS metadata and returns all three fields', async () => {
    const { fetchImpl, calls } = makeTwoStepFetch();

    const endpoints = await discoverEndpoints({ fetchImpl, home, now });

    expect(endpoints.audience).toBe(TEST_RESOURCE);
    expect(endpoints.tokenEndpoint).toBe(TEST_TOKEN_ENDPOINT);
    expect(endpoints.deviceAuthorizationEndpoint).toBe(TEST_DEVICE_AUTH_ENDPOINT);

    // Should have made exactly two HTTP calls.
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(TEST_PRM_URL);
    expect(calls[1].url).toContain('oauth-authorization-server');
  });

  test('deviceAuthorizationEndpoint is derived from issuer, not from a metadata field', async () => {
    const customIssuer = 'https://auth.example.com';
    const { fetchImpl } = makeTwoStepFetch(
      makePrmBody(),
      makeAsBody({ issuer: customIssuer }),
    );

    const endpoints = await discoverEndpoints({ fetchImpl, home, now });
    expect(endpoints.deviceAuthorizationEndpoint).toBe(
      `${customIssuer}/oauth2/device_authorization`,
    );
  });

  test('cache file is written to disk after first discovery', async () => {
    const { fetchImpl } = makeTwoStepFetch();
    await discoverEndpoints({ fetchImpl, home, now });

    const cachePath = discoveryCacheFilePath(home);
    expect(fs.existsSync(cachePath)).toBe(true);
    const raw = fs.readFileSync(cachePath, 'utf8');
    const cache = JSON.parse(raw);
    expect(cache.endpoints.audience).toBe(TEST_RESOURCE);
    expect(cache.endpoints.tokenEndpoint).toBe(TEST_TOKEN_ENDPOINT);
    expect(cache.endpoints.deviceAuthorizationEndpoint).toBe(TEST_DEVICE_AUTH_ENDPOINT);
    expect(cache.resource).toBe(`${TEST_BASE}/mcp`);
  });
});

// ---------------------------------------------------------------------------
// Cache hit (within TTL)
// ---------------------------------------------------------------------------

describe('cache hit', () => {
  test('second call within 24h returns cached data without any HTTP requests', async () => {
    const { fetchImpl, calls } = makeTwoStepFetch();

    // First call — populates cache.
    await discoverEndpoints({ fetchImpl, home, now });
    __resetInFlightForTests(); // simulate a new invocation
    calls.length = 0;

    // Second call — should hit cache (23h later, still fresh).
    let secondCalls = 0;
    const secondFetch = (async () => {
      secondCalls++;
      return new Response('', { status: 500 });
    }) as unknown as typeof fetch;

    const endpoints = await discoverEndpoints({ fetchImpl: secondFetch, home, now: FRESH_NOW });

    expect(secondCalls).toBe(0);
    expect(endpoints.audience).toBe(TEST_RESOURCE);
    expect(endpoints.tokenEndpoint).toBe(TEST_TOKEN_ENDPOINT);
  });
});

// ---------------------------------------------------------------------------
// ETag revalidation (304)
// ---------------------------------------------------------------------------

describe('ETag revalidation', () => {
  test('expired cache sends If-None-Match; 304 refreshes TTL without re-fetching AS metadata', async () => {
    // First call: PRM returns ETag, full discovery proceeds.
    const { fetchImpl: firstFetch } = makeTwoStepFetch(
      makePrmBody(),
      makeAsBody(),
      { etag: '"abc123"' },
    );
    await discoverEndpoints({ fetchImpl: firstFetch, home, now });
    __resetInFlightForTests();

    // Second call: cache is stale (25h later), server returns 304.
    const secondCalls: Array<{ url: string; headers?: Record<string, string> }> = [];
    let asCallCount = 0;
    const secondFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      const headersObj = init?.headers
        ? Object.fromEntries(new Headers(init.headers as HeadersInit).entries())
        : {};
      secondCalls.push({ url: urlStr, headers: headersObj });
      if (urlStr.includes('oauth-protected-resource')) {
        return new Response(null, { status: 304 });
      }
      if (urlStr.includes('oauth-authorization-server')) {
        asCallCount++;
        return jsonResponse(makeAsBody());
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    }) as unknown as typeof fetch;

    const endpoints = await discoverEndpoints({ fetchImpl: secondFetch, home, now: STALE_NOW });

    // Should have sent exactly one request (PRM only, with If-None-Match).
    expect(secondCalls).toHaveLength(1);
    expect(secondCalls[0].url).toBe(TEST_PRM_URL);
    expect(secondCalls[0].headers?.['if-none-match']).toBe('"abc123"');

    // AS metadata should NOT have been fetched again.
    expect(asCallCount).toBe(0);

    // Returned endpoints should match the original.
    expect(endpoints.audience).toBe(TEST_RESOURCE);
    expect(endpoints.tokenEndpoint).toBe(TEST_TOKEN_ENDPOINT);
  });

  test('304 updates fetchedAt on disk (refreshes TTL)', async () => {
    // First call with ETag.
    const { fetchImpl: firstFetch } = makeTwoStepFetch(
      makePrmBody(),
      makeAsBody(),
      { etag: '"etag-v1"' },
    );
    await discoverEndpoints({ fetchImpl: firstFetch, home, now });
    __resetInFlightForTests();

    // Second call stale, server returns 304.
    const secondFetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      if (urlStr.includes('oauth-protected-resource')) {
        return new Response(null, { status: 304 });
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    }) as unknown as typeof fetch;

    await discoverEndpoints({ fetchImpl: secondFetch, home, now: STALE_NOW });

    // The fetchedAt in the cache file should reflect STALE_NOW, not FIXED_NOW.
    const raw = fs.readFileSync(discoveryCacheFilePath(home), 'utf8');
    const cache = JSON.parse(raw);
    expect(cache.fetchedAt).toBe(STALE_NOW());
  });
});

// ---------------------------------------------------------------------------
// Network failure with stale cache
// ---------------------------------------------------------------------------

describe('network failure with stale cache', () => {
  test('returns last-known-good when PRM fetch throws on a stale cache', async () => {
    // Populate cache.
    const { fetchImpl: firstFetch } = makeTwoStepFetch();
    await discoverEndpoints({ fetchImpl: firstFetch, home, now });
    __resetInFlightForTests();

    // Network failure on second call (cache is stale).
    const failingFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const endpoints = await discoverEndpoints({ fetchImpl: failingFetch, home, now: STALE_NOW });

    expect(endpoints.audience).toBe(TEST_RESOURCE);
    expect(endpoints.tokenEndpoint).toBe(TEST_TOKEN_ENDPOINT);
  });

  test('returns last-known-good even when non-2xx response during re-fetch', async () => {
    const { fetchImpl: firstFetch } = makeTwoStepFetch();
    await discoverEndpoints({ fetchImpl: firstFetch, home, now });
    __resetInFlightForTests();

    const errFetch = (async () => new Response('Internal Server Error', { status: 503 })) as unknown as typeof fetch;

    const endpoints = await discoverEndpoints({ fetchImpl: errFetch, home, now: STALE_NOW });
    expect(endpoints.audience).toBe(TEST_RESOURCE);
  });
});

// ---------------------------------------------------------------------------
// Network failure with no cache
// ---------------------------------------------------------------------------

describe('network failure with no cache', () => {
  test('throws an actionable error naming "discovery" and the URL that failed', async () => {
    const failingFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await expect(
      discoverEndpoints({ fetchImpl: failingFetch, home, now }),
    ).rejects.toThrow('Discovery failed');
  });

  test('error message includes the PRM URL', async () => {
    const failingFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await discoverEndpoints({ fetchImpl: failingFetch, home, now });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).toContain('oauth-protected-resource');
    expect(msg.toLowerCase()).toContain('discovery');
  });

  test('throws when PRM returns non-2xx with no cache', async () => {
    const errFetch = (async () => new Response('Not Found', { status: 404 })) as unknown as typeof fetch;

    await expect(
      discoverEndpoints({ fetchImpl: errFetch, home, now }),
    ).rejects.toThrow('Discovery failed');
  });

  test('error message includes the AS metadata URL when AS fetch fails', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      if (urlStr.includes('oauth-protected-resource')) {
        return jsonResponse(makePrmBody());
      }
      // AS metadata fails.
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await discoverEndpoints({ fetchImpl, home, now });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).toContain('oauth-authorization-server');
  });
});

// ---------------------------------------------------------------------------
// Different cloudBaseUrl() invalidates cache
// ---------------------------------------------------------------------------

describe('different cloudBaseUrl invalidates cache', () => {
  test('re-fetches when cached resource differs from current cloudBaseUrl()', async () => {
    // Populate cache for TEST_BASE.
    const { fetchImpl: firstFetch } = makeTwoStepFetch();
    await discoverEndpoints({ fetchImpl: firstFetch, home, now });
    __resetInFlightForTests();

    // Switch to a different base URL.
    const ALT_BASE = 'https://staging.mcp.lore.tanagram.ai';
    process.env.LORE_MCP_BASE_URL = ALT_BASE;
    __resetCloudBaseUrlForTests();

    let prmCallUrl: string | undefined;
    const stagingFetch = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      if (urlStr.includes('oauth-protected-resource')) {
        prmCallUrl = urlStr;
        return jsonResponse(makePrmBody());
      }
      if (urlStr.includes('oauth-authorization-server')) {
        return jsonResponse(makeAsBody());
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    }) as unknown as typeof fetch;

    // This call should NOT use the cached data (wrong base URL).
    await discoverEndpoints({ fetchImpl: stagingFetch, home, now });

    // PRM was fetched from the new base URL, not the cached one.
    expect(prmCallUrl).toBe(`${ALT_BASE}/.well-known/oauth-protected-resource/mcp`);
  });

  test('wrong-resource cache is NOT used as last-known-good fallback on network failure', async () => {
    // Pre-populate the cache file with a DIFFERENT resource than what
    // cloudBaseUrl() currently returns. This simulates having previously
    // logged into staging, then switching to prod.
    const cacheDir = path.dirname(discoveryCacheFilePath(home));
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      discoveryCacheFilePath(home),
      JSON.stringify({
        resource: 'https://staging.mcp.lore.tanagram.ai/mcp', // != `${TEST_BASE}/mcp`
        endpoints: {
          audience: 'https://staging.api.lore.tanagram.ai',
          deviceAuthorizationEndpoint:
            'https://staging.signin.lore.tanagram.ai/oauth2/device_authorization',
          tokenEndpoint: 'https://staging.signin.lore.tanagram.ai/oauth2/token',
        },
        fetchedAt: FIXED_NOW,
      }),
      'utf8',
    );

    // Network failure on discovery. Must NOT silently fall back to the
    // stale wrong-environment endpoints — must throw instead.
    const failingFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await expect(
      discoverEndpoints({ fetchImpl: failingFetch, home, now }),
    ).rejects.toThrow('Discovery failed');
  });
});

// ---------------------------------------------------------------------------
// Missing PRM fields
// ---------------------------------------------------------------------------

describe('missing PRM fields', () => {
  test('throws with field name when `resource` is missing', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ authorization_servers: [TEST_AS] })) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await discoverEndpoints({ fetchImpl, home, now });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('resource');
  });

  test('throws with field name when `authorization_servers` is missing', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ resource: TEST_RESOURCE })) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await discoverEndpoints({ fetchImpl, home, now });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('authorization_servers');
  });

  test('throws when `authorization_servers` is an empty array', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ resource: TEST_RESOURCE, authorization_servers: [] })) as unknown as typeof fetch;

    await expect(discoverEndpoints({ fetchImpl, home, now })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Missing AS metadata fields
// ---------------------------------------------------------------------------

describe('missing AS metadata fields', () => {
  test('throws with field name when `token_endpoint` is missing', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      if (urlStr.includes('oauth-protected-resource')) return jsonResponse(makePrmBody());
      // AS metadata missing token_endpoint.
      return jsonResponse({ issuer: TEST_ISSUER });
    }) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await discoverEndpoints({ fetchImpl, home, now });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('token_endpoint');
  });

  test('throws with field name when `issuer` is missing', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      if (urlStr.includes('oauth-protected-resource')) return jsonResponse(makePrmBody());
      // AS metadata missing issuer.
      return jsonResponse({ token_endpoint: TEST_TOKEN_ENDPOINT });
    }) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await discoverEndpoints({ fetchImpl, home, now });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('issuer');
  });
});

// ---------------------------------------------------------------------------
// Concurrent callers dedupe to one PRM+AS fetch pair
// ---------------------------------------------------------------------------

describe('concurrent callers', () => {
  test('10 concurrent calls on cold cache produce exactly 1 PRM+AS fetch pair and all resolve identically', async () => {
    let prmCalls = 0;
    let asCalls = 0;

    // Gate the PRM fetch on a manually-resolved promise so all 10 callers
    // can pile up behind the same inFlight promise before it resolves.
    let release!: (value: Response) => void;
    const gate = new Promise<Response>((res) => {
      release = res;
    });

    const fetchImpl = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      if (urlStr.includes('oauth-protected-resource')) {
        prmCalls++;
        return gate;
      }
      if (urlStr.includes('oauth-authorization-server')) {
        asCalls++;
        return jsonResponse(makeAsBody());
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    }) as unknown as typeof fetch;

    const promises = Array.from({ length: 10 }, () =>
      discoverEndpoints({ fetchImpl, home, now }),
    );

    // Give the event loop a tick so all 10 callers hit the inFlight check.
    await new Promise((r) => setTimeout(r, 10));

    // Release the gate with the PRM response.
    release(jsonResponse(makePrmBody()));

    const results = await Promise.all(promises);

    // Exactly one PRM call and one AS call.
    expect(prmCalls).toBe(1);
    expect(asCalls).toBe(1);

    // All callers received the same result.
    for (const r of results) {
      expect(r.audience).toBe(TEST_RESOURCE);
      expect(r.tokenEndpoint).toBe(TEST_TOKEN_ENDPOINT);
      expect(r.deviceAuthorizationEndpoint).toBe(TEST_DEVICE_AUTH_ENDPOINT);
    }
  });

  test('all concurrent callers reject together when discovery fails', async () => {
    let release!: (value: Response) => void;
    const gate = new Promise<Response>((res) => {
      release = res;
    });

    const fetchImpl = (async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
      if (urlStr.includes('oauth-protected-resource')) {
        return gate;
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    }) as unknown as typeof fetch;

    const promises = Array.from({ length: 5 }, () =>
      discoverEndpoints({ fetchImpl, home, now }),
    );

    await new Promise((r) => setTimeout(r, 10));
    release(new Response('Internal Error', { status: 500 }));

    const settled = await Promise.allSettled(promises);
    for (const s of settled) {
      expect(s.status).toBe('rejected');
    }
  });

  test('inFlight is cleared after rejection (subsequent call retries discovery)', async () => {
    // First call fails.
    const failFetch = (async () =>
      new Response('Server Error', { status: 500 })) as unknown as typeof fetch;
    await expect(discoverEndpoints({ fetchImpl: failFetch, home, now })).rejects.toThrow();

    // inFlight should be cleared by .finally. Second call should succeed.
    const { fetchImpl: goodFetch } = makeTwoStepFetch();
    const endpoints = await discoverEndpoints({ fetchImpl: goodFetch, home, now });
    expect(endpoints.audience).toBe(TEST_RESOURCE);
  });
});

// ---------------------------------------------------------------------------
// __resetInFlightForTests
// ---------------------------------------------------------------------------

describe('__resetInFlightForTests', () => {
  test('clears a hung inFlight slot so subsequent calls can succeed', async () => {
    const hungGate = new Promise<Response>(() => {
      // never resolves
    });
    const hungFetch = (async () => hungGate) as unknown as typeof fetch;

    // Kick off, do not await.
    const leaked = discoverEndpoints({ fetchImpl: hungFetch, home, now });
    await new Promise((r) => setTimeout(r, 5));

    __resetInFlightForTests();

    // Should succeed now.
    const { fetchImpl: goodFetch } = makeTwoStepFetch();
    const endpoints = await discoverEndpoints({ fetchImpl: goodFetch, home, now });
    expect(endpoints.audience).toBe(TEST_RESOURCE);

    void leaked; // silence the never-resolving promise
  });
});
