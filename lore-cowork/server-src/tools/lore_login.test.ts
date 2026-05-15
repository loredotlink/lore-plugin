import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLoreLogin } from './lore_login';
import { readTokens } from '../lib/tokens';
import { __resetCloudBaseUrlForTests } from '../lib/cloudBaseUrl';

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-cowork-login-test-'));
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

function deviceCodeBody(overrides: Record<string, unknown> = {}) {
  return {
    device_code: 'dev-CODE',
    user_code: 'WXYZ-1234',
    verification_uri: 'http://localhost:4000/device',
    verification_uri_complete: 'http://localhost:4000/device?user_code=WXYZ-1234',
    expires_in: 600,
    interval: 5,
    ...overrides,
  };
}

function tokenPairBody(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'access-NEW',
    refresh_token: 'refresh-NEW',
    expires_in: 3600,
    token_type: 'Bearer',
    scope: 'mcp.read mcp.write',
    ...overrides,
  };
}

/**
 * Build a fetch stub that returns a queued sequence of responses keyed
 * by URL. Each URL maps to a FIFO queue; if the queue empties the stub
 * throws so a misordered test fails loudly.
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
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body as string | undefined });
    const q = queues.get(url);
    if (!q || q.length === 0) {
      throw new Error(`unexpected fetch call to ${url}`);
    }
    const next = q.shift()!;
    return typeof next === 'function' ? next() : next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Sleep stub that records each awaited ms and resolves synchronously. */
function makeSleep(): { sleep: (ms: number) => Promise<void>; awaited: number[] } {
  const awaited: number[] = [];
  const sleep = async (ms: number) => {
    awaited.push(ms);
  };
  return { sleep, awaited };
}

const DEVICE_URL = 'http://localhost:4000/oauth/device/code';
const TOKEN_URL = 'http://localhost:4000/oauth/token';

describe('runLoreLogin', () => {
  let home: string;
  beforeEach(() => {
    home = makeTmpHome();
    process.env.LORE_MCP_BASE_URL = 'http://localhost:4000';
    __resetCloudBaseUrlForTests();
  });
  afterEach(() => {
    rmrf(home);
    delete process.env.LORE_MCP_BASE_URL;
    __resetCloudBaseUrlForTests();
  });

  test('happy path: device-code → browser opens → pending → token pair → writeTokens called', async () => {
    const FIXED_NOW = 1_700_000_000_000;
    let nowCallCount = 0;
    const now = () => {
      nowCallCount++;
      return FIXED_NOW + nowCallCount;
    };
    const { fetchImpl, calls } = makeFetch([
      { url: DEVICE_URL, res: jsonResponse(deviceCodeBody()) },
      { url: TOKEN_URL, res: jsonResponse({ error: 'authorization_pending' }, 400) },
      { url: TOKEN_URL, res: jsonResponse(tokenPairBody({ expires_in: 3600 })) },
    ]);
    const { sleep, awaited } = makeSleep();
    const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
    const spawnImpl = (cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args });
      return { status: 0 };
    };

    const result = await runLoreLogin({ fetchImpl, spawnImpl, now, sleep, home });

    expect(result).toEqual({ ok: true });
    // Two polls at the default 5s interval.
    expect(awaited).toEqual([5000, 5000]);
    // Browser opened with the complete URL.
    expect(spawnCalls).toEqual([
      { cmd: 'open', args: ['http://localhost:4000/device?user_code=WXYZ-1234'] },
    ]);
    // Device-code POST shape.
    const deviceParams = new URLSearchParams(calls[0]?.body ?? '');
    expect(deviceParams.get('client_id')).toBe('lore-cowork-plugin');
    expect(deviceParams.get('scope')).toBe('mcp.read mcp.write');
    // Poll POST shape.
    const pollParams = new URLSearchParams(calls[1]?.body ?? '');
    expect(pollParams.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:device_code',
    );
    expect(pollParams.get('device_code')).toBe('dev-CODE');
    expect(pollParams.get('client_id')).toBe('lore-cowork-plugin');
    // Tokens persisted with locally-computed expires_at and the fixed scope.
    const persisted = await readTokens(home);
    expect(persisted).not.toBeNull();
    expect(persisted?.access_token).toBe('access-NEW');
    expect(persisted?.refresh_token).toBe('refresh-NEW');
    expect(persisted?.scope).toBe('mcp.read mcp.write');
    // expires_at = now() (at success) + 3600*1000. now is monotonic so
    // it must be > FIXED_NOW + 3600_000 by a small amount.
    expect(persisted!.expires_at).toBeGreaterThan(FIXED_NOW + 3_600_000);
    expect(persisted!.expires_at).toBeLessThan(FIXED_NOW + 3_600_000 + 1000);
  });

  test('happy-path return value does not leak credentials', async () => {
    const now = () => 1_700_000_000_000;
    const { fetchImpl } = makeFetch([
      { url: DEVICE_URL, res: jsonResponse(deviceCodeBody()) },
      { url: TOKEN_URL, res: jsonResponse(tokenPairBody()) },
    ]);
    const { sleep } = makeSleep();
    const result = await runLoreLogin({
      fetchImpl,
      spawnImpl: () => ({ status: 0 }),
      now,
      sleep,
      home,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('dev-CODE');
    expect(serialized).not.toContain('access-NEW');
    expect(serialized).not.toContain('refresh-NEW');
  });

  test('browser open fails (exit 1): returns browser_open_failed, no polling, no tokens written', async () => {
    const now = () => 1_700_000_000_000;
    const { fetchImpl, calls } = makeFetch([
      { url: DEVICE_URL, res: jsonResponse(deviceCodeBody()) },
    ]);
    const { sleep, awaited } = makeSleep();
    const result = await runLoreLogin({
      fetchImpl,
      spawnImpl: () => ({ status: 1 }),
      now,
      sleep,
      home,
    });

    expect(result.ok).toBe(false);
    if (result.ok === false && result.reason === 'browser_open_failed') {
      expect(result.device_code).toBe('dev-CODE');
      expect(result.user_code).toBe('WXYZ-1234');
      expect(result.verification_uri).toBe('http://localhost:4000/device');
      expect(result.message).toContain('lore_login_resume');
      expect(result.message).toContain('http://localhost:4000/device');
    } else {
      throw new Error('expected browser_open_failed');
    }
    // Only the device-code POST should have been called.
    expect(calls.length).toBe(1);
    expect(awaited).toEqual([]);
    // tokens file must not exist.
    expect(await readTokens(home)).toBeNull();
  });

  test('slow_down adds 5s to the local interval; second slow_down adds another 5s', async () => {
    const now = () => 1_700_000_000_000;
    const { fetchImpl } = makeFetch([
      { url: DEVICE_URL, res: jsonResponse(deviceCodeBody({ interval: 5 })) },
      { url: TOKEN_URL, res: jsonResponse({ error: 'authorization_pending' }, 400) },
      { url: TOKEN_URL, res: jsonResponse({ error: 'slow_down' }, 400) },
      { url: TOKEN_URL, res: jsonResponse({ error: 'slow_down' }, 400) },
      { url: TOKEN_URL, res: jsonResponse(tokenPairBody()) },
    ]);
    const { sleep, awaited } = makeSleep();
    const result = await runLoreLogin({
      fetchImpl,
      spawnImpl: () => ({ status: 0 }),
      now,
      sleep,
      home,
    });
    expect(result).toEqual({ ok: true });
    // Iteration cadence:
    //   iter 1: sleep(5000), poll → authorization_pending
    //   iter 2: sleep(5000), poll → slow_down (interval becomes 10)
    //   iter 3: sleep(10000), poll → slow_down (interval becomes 15)
    //   iter 4: sleep(15000), poll → success
    expect(awaited).toEqual([5000, 5000, 10000, 15000]);
  });

  test('server returns expired_token: returns expired_token shape; no tokens written', async () => {
    const now = () => 1_700_000_000_000;
    const { fetchImpl } = makeFetch([
      { url: DEVICE_URL, res: jsonResponse(deviceCodeBody()) },
      { url: TOKEN_URL, res: jsonResponse({ error: 'expired_token' }, 400) },
    ]);
    const { sleep } = makeSleep();
    const result = await runLoreLogin({
      fetchImpl,
      spawnImpl: () => ({ status: 0 }),
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

  test('hard cap: test clock advances past expires_in*1000 while server keeps returning pending', async () => {
    // device-code says expires_in = 600. After the device-code response,
    // start = now() at that instant. We advance the clock by 200s on
    // each subsequent now() call, so after 3 polls we've crossed 600s.
    const FIXED_START = 1_700_000_000_000;
    let calls = 0;
    const now = () => {
      // 0: post-device-code (start anchor)
      // 1: top of iter 1 (delta 0) — still under
      // 2: top of iter 2 (delta 200_000) — still under
      // 3: top of iter 3 (delta 400_000) — still under
      // 4: top of iter 4 (delta 600_000) — equal → expired
      const t = FIXED_START + calls * 200_000;
      calls++;
      return t;
    };
    // Build enough pending responses to cover the loop iterations
    // before the cap kicks in.
    const { fetchImpl } = makeFetch([
      { url: DEVICE_URL, res: jsonResponse(deviceCodeBody({ expires_in: 600, interval: 1 })) },
      { url: TOKEN_URL, res: jsonResponse({ error: 'authorization_pending' }, 400) },
      { url: TOKEN_URL, res: jsonResponse({ error: 'authorization_pending' }, 400) },
      { url: TOKEN_URL, res: jsonResponse({ error: 'authorization_pending' }, 400) },
    ]);
    const { sleep } = makeSleep();
    const result = await runLoreLogin({
      fetchImpl,
      spawnImpl: () => ({ status: 0 }),
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

  test('unknown cloud error surfaces error code but not error_description', async () => {
    const now = () => 1_700_000_000_000;
    const { fetchImpl } = makeFetch([
      { url: DEVICE_URL, res: jsonResponse(deviceCodeBody()) },
      {
        url: TOKEN_URL,
        res: jsonResponse(
          { error: 'invalid_client', error_description: 'should-not-leak' },
          400,
        ),
      },
    ]);
    const { sleep } = makeSleep();
    let caught: Error | null = null;
    try {
      await runLoreLogin({
        fetchImpl,
        spawnImpl: () => ({ status: 0 }),
        now,
        sleep,
        home,
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    // Surfaces the well-known OAuth error code.
    expect(caught!.message).toContain('invalid_client');
    // Must NOT echo error_description content.
    expect(caught!.message).not.toContain('should-not-leak');
    expect(caught!.message).not.toContain('error_description');
    expect(await readTokens(home)).toBeNull();
  });

  test('poll error_description echoing device_code does not leak the device_code', async () => {
    // Locks in the fix for the credential-leak vector where the cloud's
    // `error_description` echoes the submitted `device_code`. The
    // thrown Error must not contain the device_code substring.
    const now = () => 1_700_000_000_000;
    const { fetchImpl } = makeFetch([
      { url: DEVICE_URL, res: jsonResponse(deviceCodeBody({ device_code: 'dev-CODE-12345' })) },
      {
        url: TOKEN_URL,
        res: jsonResponse(
          {
            error: 'invalid_client',
            error_description: 'echoed dev-CODE-12345',
          },
          400,
        ),
      },
    ]);
    const { sleep } = makeSleep();
    let caught: Error | null = null;
    try {
      await runLoreLogin({
        fetchImpl,
        spawnImpl: () => ({ status: 0 }),
        now,
        sleep,
        home,
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('invalid_client');
    expect(caught!.message).not.toContain('dev-CODE-12345');
  });
});
