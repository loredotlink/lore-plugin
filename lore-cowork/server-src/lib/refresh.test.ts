import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthRequiredError } from './errors';
import {
  getValidAccessToken,
  __resetInFlightForTests,
} from './refresh';
import {
  readTokens,
  writeTokens,
  tokensFilePath,
  type Tokens,
} from './tokens';
import { __resetCloudBaseUrlForTests } from './cloudBaseUrl';

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-cowork-refresh-test-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

const FIXED_NOW = 1_700_000_000_000; // arbitrary epoch ms
const now = () => FIXED_NOW;

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

describe('getValidAccessToken', () => {
  let home: string;
  beforeEach(() => {
    home = makeTmpHome();
    __resetInFlightForTests();
    // Pin the base URL to a stable test value so the assertion below
    // can inspect the request URL.
    process.env.LORE_MCP_BASE_URL = 'http://localhost:4000';
    __resetCloudBaseUrlForTests();
  });
  afterEach(() => {
    rmrf(home);
    delete process.env.LORE_MCP_BASE_URL;
    __resetCloudBaseUrlForTests();
    __resetInFlightForTests();
  });

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
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse(successRefreshBody(), 200);
    }) as unknown as typeof fetch;
    const got = await getValidAccessToken({ now, fetchImpl, home });
    expect(got).toBe('access-NEW');
    expect(calls).toBe(1);
  });

  test('refreshes when expires_at < now (clearly expired)', async () => {
    await writeTokens(expiredTokens({ expires_at: FIXED_NOW - 5_000 }), home);
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse(successRefreshBody(), 200);
    }) as unknown as typeof fetch;
    const got = await getValidAccessToken({ now, fetchImpl, home });
    expect(got).toBe('access-NEW');
    expect(calls).toBe(1);
  });

  test('refresh POSTs form-urlencoded body with grant_type, refresh_token, client_id', async () => {
    await writeTokens(expiredTokens(), home);
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse(successRefreshBody(), 200);
    }) as unknown as typeof fetch;
    await getValidAccessToken({ now, fetchImpl, home });

    expect(capturedUrl).toBe('http://localhost:4000/oauth/token');
    expect(capturedInit?.method).toBe('POST');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const body = capturedInit?.body;
    expect(typeof body).toBe('string');
    const params = new URLSearchParams(body as string);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('refresh-OLD');
    expect(params.get('client_id')).toBe('lore-cowork-plugin');
  });

  test('persists new tokens after successful refresh with expires_at computed locally', async () => {
    await writeTokens(expiredTokens(), home);
    const fetchImpl = (async () =>
      jsonResponse(successRefreshBody({ expires_in: 600 }), 200)) as unknown as typeof fetch;
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

  test('ignores any server-supplied expires_at; only local now() + expires_in counts', async () => {
    await writeTokens(expiredTokens(), home);
    // Server tries to lie about expires_at — we must ignore it.
    const fetchImpl = (async () =>
      jsonResponse(
        successRefreshBody({
          expires_in: 300,
          expires_at: 999_999_999_999, // server-supplied, should be ignored
        }),
        200,
      )) as unknown as typeof fetch;
    await getValidAccessToken({ now, fetchImpl, home });
    const persisted = await readTokens(home);
    expect(persisted?.expires_at).toBe(FIXED_NOW + 300_000);
  });

  test('invalid_grant response deletes tokens file and throws AuthRequiredError', async () => {
    await writeTokens(expiredTokens(), home);
    const fetchImpl = (async () =>
      jsonResponse(
        { error: 'invalid_grant', error_description: 'expired' },
        400,
      )) as unknown as typeof fetch;
    await expect(
      getValidAccessToken({ now, fetchImpl, home }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    expect(fs.existsSync(tokensFilePath(home))).toBe(false);
  });

  test('non-invalid_grant 4xx error is thrown verbatim and tokens are preserved', async () => {
    const tokens = expiredTokens();
    await writeTokens(tokens, home);
    const fetchImpl = (async () =>
      new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    await expect(
      getValidAccessToken({ now, fetchImpl, home }),
    ).rejects.not.toBeInstanceOf(AuthRequiredError);
    // Tokens file must still be present and unmodified.
    expect(await readTokens(home)).toEqual(tokens);
  });

  test('5xx error is thrown verbatim and tokens are preserved', async () => {
    const tokens = expiredTokens();
    await writeTokens(tokens, home);
    const fetchImpl = (async () =>
      new Response('boom', { status: 503 })) as unknown as typeof fetch;
    await expect(
      getValidAccessToken({ now, fetchImpl, home }),
    ).rejects.not.toBeInstanceOf(AuthRequiredError);
    expect(await readTokens(home)).toEqual(tokens);
  });

  test('successful 200 with schema-invalid body (missing fields) throws and preserves tokens', async () => {
    const tokens = expiredTokens();
    await writeTokens(tokens, home);
    const fetchImpl = (async () =>
      jsonResponse({ access_token: 'a' }, 200)) as unknown as typeof fetch;
    await expect(
      getValidAccessToken({ now, fetchImpl, home }),
    ).rejects.not.toBeInstanceOf(AuthRequiredError);
    // File must be unchanged.
    expect(await readTokens(home)).toEqual(tokens);
  });

  test('successful 200 with non-integer expires_in throws and preserves tokens', async () => {
    const tokens = expiredTokens();
    await writeTokens(tokens, home);
    const fetchImpl = (async () =>
      jsonResponse(successRefreshBody({ expires_in: 300.5 }), 200)) as unknown as typeof fetch;
    await expect(
      getValidAccessToken({ now, fetchImpl, home }),
    ).rejects.not.toBeInstanceOf(AuthRequiredError);
    expect(await readTokens(home)).toEqual(tokens);
  });

  test('network error is thrown verbatim and tokens are preserved', async () => {
    const tokens = expiredTokens();
    await writeTokens(tokens, home);
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(
      getValidAccessToken({ now, fetchImpl, home }),
    ).rejects.toThrow('ECONNREFUSED');
    expect(await readTokens(home)).toEqual(tokens);
  });

  test('mutex: 10 concurrent calls on expired tokens produce exactly 1 POST and all resolve to the same access token', async () => {
    await writeTokens(expiredTokens(), home);
    let calls = 0;
    // Gate the fetch on a manually-resolved promise so all 10 callers
    // land in the same await before we let any of them complete.
    let release!: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchImpl = (async () => {
      calls++;
      return gate;
    }) as unknown as typeof fetch;

    const promises = Array.from({ length: 10 }, () =>
      getValidAccessToken({ now, fetchImpl, home }),
    );

    // Give the event loop a tick so all 10 callers can hit the inFlight
    // check before we release the gate.
    await new Promise((r) => setTimeout(r, 10));
    release(jsonResponse(successRefreshBody(), 200));

    const results = await Promise.all(promises);
    expect(calls).toBe(1);
    expect(results).toEqual(Array(10).fill('access-NEW'));
  });

  test('mutex error path: 10 concurrent calls all reject with AuthRequiredError; tokens deleted once; inFlight is cleared', async () => {
    await writeTokens(expiredTokens(), home);
    let calls = 0;
    let release!: (value: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchImpl = (async () => {
      calls++;
      return gate;
    }) as unknown as typeof fetch;

    const promises = Array.from({ length: 10 }, () =>
      getValidAccessToken({ now, fetchImpl, home }),
    );
    await new Promise((r) => setTimeout(r, 10));
    release(jsonResponse({ error: 'invalid_grant' }, 400));

    const settled = await Promise.allSettled(promises);
    expect(calls).toBe(1);
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
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse(successRefreshBody(), 200);
    }) as unknown as typeof fetch;
    const first = await getValidAccessToken({ now, fetchImpl, home });
    expect(first).toBe('access-NEW');
    expect(calls).toBe(1);
    // The new token expires at now+300s, well past the 30s window.
    const second = await getValidAccessToken({ now, fetchImpl, home });
    expect(second).toBe('access-NEW');
    expect(calls).toBe(1);
  });

  test('__resetInFlightForTests clears a leaked inFlight slot between tests', async () => {
    // Simulate a hung inFlight from a prior test: by gating fetch we
    // start a refresh, then call the reset helper, and verify the next
    // call kicks off a fresh refresh rather than awaiting the dead one.
    await writeTokens(expiredTokens(), home);
    const hungGate = new Promise<Response>(() => {
      // never resolves
    });
    const hungFetch = (async () => hungGate) as unknown as typeof fetch;
    // Kick off, but do not await.
    const leaked = getValidAccessToken({ now, fetchImpl: hungFetch, home });
    // Tick.
    await new Promise((r) => setTimeout(r, 5));

    // Clear the slot.
    __resetInFlightForTests();

    // A new call with a working fetch should complete normally.
    const workingFetch = (async () =>
      jsonResponse(successRefreshBody(), 200)) as unknown as typeof fetch;
    const got = await getValidAccessToken({ now, fetchImpl: workingFetch, home });
    expect(got).toBe('access-NEW');

    // Silence the leaked promise; it will never resolve, which is fine
    // for the test process.
    void leaked;
  });
});
