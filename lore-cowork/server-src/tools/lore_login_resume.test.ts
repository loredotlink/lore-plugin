import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLoreLoginResume } from './lore_login_resume';
import { readTokens } from '../lib/auth/store';
import { __resetCloudBaseUrlForTests } from '../lib/cloudBaseUrl';
import {
  discoverEndpoints,
  __resetInFlightForTests as __resetDiscoveryInFlightForTests,
} from '../lib/auth/discovery';
import { AUTHKIT_CLIENT_ID, AUTHKIT_SCOPES } from '../lib/auth/constants';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_BASE = 'https://mcp.lore.tanagram.ai';
const TEST_AS = 'https://signin.lore.tanagram.ai';
const TEST_RESOURCE = 'https://api.lore.tanagram.ai';
const TEST_ISSUER = 'https://signin.lore.tanagram.ai';
const TEST_TOKEN_ENDPOINT = `${TEST_ISSUER}/oauth2/token`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-cowork-resume-test-'));
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

function tokenPairBody(overrides: Record<string, unknown> = {}) {
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
 * Build a routing fetchImpl that handles discovery URLs + token endpoint
 * with a FIFO queue for token endpoint responses.
 */
function makeFetch(seq: Array<{ url: string; res: Response | (() => Response) }>): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; body: string | undefined }>;
} {
  const queues = new Map<string, Array<Response | (() => Response)>>();
  for (const { url, res } of seq) {
    if (!queues.has(url)) queues.set(url, []);
    queues.get(url)!.push(res);
  }
  const calls: Array<{ url: string; body: string | undefined }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr =
      typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
    calls.push({ url: urlStr, body: init?.body as string | undefined });
    // Discovery URLs: always return standard defaults.
    if (urlStr.includes('oauth-protected-resource')) {
      return jsonResponse(makePrmBody());
    }
    if (urlStr.includes('oauth-authorization-server')) {
      return jsonResponse(makeAsBody());
    }
    const q = queues.get(urlStr);
    if (!q || q.length === 0) {
      throw new Error(`unexpected fetch call to ${urlStr}`);
    }
    const next = q.shift()!;
    return typeof next === 'function' ? next() : next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeSleep(): { sleep: (ms: number) => Promise<void>; awaited: number[] } {
  const awaited: number[] = [];
  const sleep = async (ms: number) => {
    awaited.push(ms);
  };
  return { sleep, awaited };
}

/**
 * Prime the on-disk discovery cache so tests that only exercise the poll logic
 * don't need their fetchImpl to handle PRM/AS URLs.
 */
async function primeDiscoveryCache(home: string): Promise<void> {
  const primeFetch = (async (url: string | URL | Request) => {
    const urlStr =
      typeof url === 'string' ? url : url instanceof URL ? url.toString() : (url as Request).url;
    if (urlStr.includes('oauth-protected-resource')) return jsonResponse(makePrmBody());
    if (urlStr.includes('oauth-authorization-server')) return jsonResponse(makeAsBody());
    throw new Error(`Unexpected URL in primeDiscoveryCache: ${urlStr}`);
  }) as unknown as typeof fetch;
  const now = () => 1_700_000_000_000;
  await discoverEndpoints({ fetchImpl: primeFetch, home, now });
  __resetDiscoveryInFlightForTests();
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

describe('runLoreLoginResume', () => {
  let home: string;
  beforeEach(async () => {
    home = makeTmpHome();
    process.env.LORE_MCP_BASE_URL = TEST_BASE;
    __resetCloudBaseUrlForTests();
    __resetDiscoveryInFlightForTests();
    await primeDiscoveryCache(home);
  });
  afterEach(() => {
    rmrf(home);
    delete process.env.LORE_MCP_BASE_URL;
    __resetCloudBaseUrlForTests();
    __resetDiscoveryInFlightForTests();
  });

  test('happy path with explicit expires_in/interval: pending → tokens → writeTokens called', async () => {
    const FIXED_NOW = 1_700_000_000_000;
    let n = 0;
    const now = () => FIXED_NOW + ++n;
    const { fetchImpl, calls } = makeFetch([
      { url: TEST_TOKEN_ENDPOINT, res: jsonResponse({ error: 'authorization_pending' }, 400) },
      { url: TEST_TOKEN_ENDPOINT, res: jsonResponse(tokenPairBody({ expires_in: 3600 })) },
    ]);
    const { sleep, awaited } = makeSleep();

    const result = await runLoreLoginResume({
      device_code: 'dev-RESUME',
      expires_in_seconds: 600,
      interval_seconds: 3,
      fetchImpl,
      now,
      sleep,
      home,
    });

    expect(result).toEqual({ ok: true });
    expect(awaited).toEqual([3000, 3000]);
    // Poll POST shape carries the supplied device_code.
    const pollCall = calls.find((c) => c.url === TEST_TOKEN_ENDPOINT);
    expect(pollCall).toBeDefined();
    const pollParams = new URLSearchParams(pollCall?.body ?? '');
    expect(pollParams.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:device_code',
    );
    expect(pollParams.get('device_code')).toBe('dev-RESUME');
    expect(pollParams.get('client_id')).toBe(AUTHKIT_CLIENT_ID);
    // Tokens persisted with locally-computed expires_at.
    const persisted = await readTokens(home);
    expect(persisted).not.toBeNull();
    expect(persisted?.access_token).toBe('access-NEW');
    expect(persisted?.refresh_token).toBe('refresh-NEW');
    expect(persisted?.scope).toBe(AUTHKIT_SCOPES);
    expect(persisted!.expires_at).toBeGreaterThan(FIXED_NOW + 3_600_000);
    expect(persisted!.expires_at).toBeLessThan(FIXED_NOW + 3_600_000 + 1000);
  });

  test('defaults applied: omitted expires_in/interval → 600s cap, 5s interval', async () => {
    // Cap of 600s. Advance clock by 200s per now() so after 3 polls we hit the cap.
    const FIXED_START = 1_700_000_000_000;
    let calls = 0;
    const now = () => {
      const t = FIXED_START + calls * 200_000;
      calls++;
      return t;
    };
    const { fetchImpl } = makeFetch([
      { url: TEST_TOKEN_ENDPOINT, res: jsonResponse({ error: 'authorization_pending' }, 400) },
      { url: TEST_TOKEN_ENDPOINT, res: jsonResponse({ error: 'authorization_pending' }, 400) },
      { url: TEST_TOKEN_ENDPOINT, res: jsonResponse({ error: 'authorization_pending' }, 400) },
    ]);
    const { sleep, awaited } = makeSleep();

    const result = await runLoreLoginResume({
      device_code: 'dev-RESUME',
      fetchImpl,
      now,
      sleep,
      home,
    });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe('expired_token');
    }
    // Each recorded sleep must be 5000ms — the default interval.
    expect(awaited.length).toBeGreaterThan(0);
    for (const ms of awaited) {
      expect(ms).toBe(5000);
    }
  });

  test('slow_down adds 5s to the local interval', async () => {
    const now = () => 1_700_000_000_000;
    const { fetchImpl } = makeFetch([
      { url: TEST_TOKEN_ENDPOINT, res: jsonResponse({ error: 'authorization_pending' }, 400) },
      { url: TEST_TOKEN_ENDPOINT, res: jsonResponse({ error: 'slow_down' }, 400) },
      { url: TEST_TOKEN_ENDPOINT, res: jsonResponse(tokenPairBody()) },
    ]);
    const { sleep, awaited } = makeSleep();

    const result = await runLoreLoginResume({
      device_code: 'dev-RESUME',
      expires_in_seconds: 600,
      interval_seconds: 5,
      fetchImpl,
      now,
      sleep,
      home,
    });

    expect(result).toEqual({ ok: true });
    // iter1: sleep(5000), pending; iter2: sleep(5000), slow_down → 10;
    // iter3: sleep(10000), success.
    expect(awaited).toEqual([5000, 5000, 10000]);
  });

  test('server expired_token: returns expired_token shape; no tokens written', async () => {
    const now = () => 1_700_000_000_000;
    const { fetchImpl } = makeFetch([
      { url: TEST_TOKEN_ENDPOINT, res: jsonResponse({ error: 'expired_token' }, 400) },
    ]);
    const { sleep } = makeSleep();
    const result = await runLoreLoginResume({
      device_code: 'dev-RESUME',
      expires_in_seconds: 600,
      interval_seconds: 5,
      fetchImpl,
      now,
      sleep,
      home,
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe('expired_token');
      expect(result).toHaveProperty('message');
    }
    expect(await readTokens(home)).toBeNull();
  });

  test('hard cap: returns expired_token shape; no tokens written', async () => {
    // expires_in_seconds = 10, advance by 5s each now() call → cap hit fast.
    const FIXED_START = 1_700_000_000_000;
    let calls = 0;
    const now = () => {
      const t = FIXED_START + calls * 5_000;
      calls++;
      return t;
    };
    const { fetchImpl } = makeFetch([
      { url: TEST_TOKEN_ENDPOINT, res: jsonResponse({ error: 'authorization_pending' }, 400) },
      { url: TEST_TOKEN_ENDPOINT, res: jsonResponse({ error: 'authorization_pending' }, 400) },
      { url: TEST_TOKEN_ENDPOINT, res: jsonResponse({ error: 'authorization_pending' }, 400) },
    ]);
    const { sleep } = makeSleep();
    const result = await runLoreLoginResume({
      device_code: 'dev-RESUME',
      expires_in_seconds: 10,
      interval_seconds: 1,
      fetchImpl,
      now,
      sleep,
      home,
    });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.reason).toBe('expired_token');
    }
    expect(await readTokens(home)).toBeNull();
  });

  test('no leaked credentials: thrown Error does not contain the device_code', async () => {
    const now = () => 1_700_000_000_000;
    const { fetchImpl } = makeFetch([
      {
        url: TEST_TOKEN_ENDPOINT,
        res: jsonResponse(
          { error: 'invalid_client', error_description: 'echoed dev-XYZ-99' },
          400,
        ),
      },
    ]);
    const { sleep } = makeSleep();
    let caught: Error | null = null;
    try {
      await runLoreLoginResume({
        device_code: 'dev-XYZ-99',
        expires_in_seconds: 600,
        interval_seconds: 5,
        fetchImpl,
        now,
        sleep,
        home,
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('invalid_client');
    expect(caught!.message).not.toContain('dev-XYZ-99');
    expect(caught!.message).not.toContain('error_description');
  });

  test('independence: works with no prior runLoreLogin in the same process', async () => {
    // No module-state setup happens between tests; this test simply
    // calls resume directly with a fresh tmp home and asserts the flow
    // completes. The other tests already do this — this case is here
    // explicitly to lock in the contract.
    const now = () => 1_700_000_000_000;
    const { fetchImpl } = makeFetch([
      { url: TEST_TOKEN_ENDPOINT, res: jsonResponse(tokenPairBody()) },
    ]);
    const { sleep } = makeSleep();
    const result = await runLoreLoginResume({
      device_code: 'dev-COLD',
      expires_in_seconds: 600,
      interval_seconds: 5,
      fetchImpl,
      now,
      sleep,
      home,
    });
    expect(result).toEqual({ ok: true });
    const persisted = await readTokens(home);
    expect(persisted?.access_token).toBe('access-NEW');
  });
});
