import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthRequiredError } from './errors';
import { callCloudTool } from './cloudCall';
import { __resetInFlightForTests } from './refresh';
import {
  writeTokens,
  readTokens,
  type Tokens,
} from './tokens';
import { __resetCloudBaseUrlForTests } from './cloudBaseUrl';

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-cowork-cloudcall-test-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Tokens with an expires_at far in the future so getValidAccessToken
// never tries to refresh — keeps the cloudCall tests focused on what
// cloudCall itself does.
function validTokens(): Tokens {
  return {
    access_token: 'access-LIVE',
    refresh_token: 'refresh-LIVE',
    expires_at: Date.now() + 60 * 60 * 1000,
    scope: 'mcp.read mcp.write',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function rpcSuccess(id: string, result: unknown): Response {
  return jsonResponse({ jsonrpc: '2.0', id, result });
}

function rpcError(
  id: string,
  err: { code?: number; message?: string; data?: unknown },
): Response {
  return jsonResponse({ jsonrpc: '2.0', id, error: err });
}

interface CapturedRequest {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: unknown;
}

function captureFetch(
  responder: (req: CapturedRequest) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl = (async (
    url: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      // The cloudCall implementation passes a plain object; normalize
      // the keys so assertions don't depend on header-name casing.
      for (const [k, v] of Object.entries(
        init.headers as Record<string, string>,
      )) {
        headers[k.toLowerCase()] = v;
      }
    }
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const cap: CapturedRequest = {
      url: String(url),
      method: init?.method,
      headers,
      body,
    };
    calls.push(cap);
    return responder(cap);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('callCloudTool', () => {
  let home: string;
  beforeEach(() => {
    home = makeTmpHome();
    __resetInFlightForTests();
    process.env.LORE_MCP_BASE_URL = 'http://localhost:4000';
    __resetCloudBaseUrlForTests();
  });
  afterEach(() => {
    rmrf(home);
    delete process.env.LORE_MCP_BASE_URL;
    __resetCloudBaseUrlForTests();
    __resetInFlightForTests();
  });

  test('happy path: returns result, sends bearer + content-type, POSTs to /mcp', async () => {
    await writeTokens(validTokens(), home);
    const expectedResult = { thread_id: 't_123', url: 'https://lore/x' };
    const { fetchImpl, calls } = captureFetch((req) =>
      rpcSuccess((req.body as { id: string }).id, expectedResult),
    );
    const result = await callCloudTool(
      'share_session',
      { harness: 'cowork', title: 'hello' },
      { fetchImpl, home },
    );
    expect(result).toEqual(expectedResult);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe('http://localhost:4000/mcp');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['authorization']).toBe('Bearer access-LIVE');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body.jsonrpc).toBe('2.0');
    expect(body.method).toBe('tools/call');
    expect(typeof body.id).toBe('string');
    expect((body.id as string).length).toBeGreaterThan(0);
    expect(body.params).toEqual({
      name: 'share_session',
      arguments: { harness: 'cowork', title: 'hello' },
    });
  });

  test('AuthRequiredError from getValidAccessToken propagates and fetch is never called', async () => {
    // No tokens file → getValidAccessToken throws AuthRequiredError.
    const { fetchImpl, calls } = captureFetch(() =>
      jsonResponse({ shouldNotHappen: true }),
    );
    await expect(
      callCloudTool('share_session', {}, { fetchImpl, home }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    expect(calls.length).toBe(0);
  });

  test('401 from cloud: deletes tokens and throws AuthRequiredError', async () => {
    await writeTokens(validTokens(), home);
    const { fetchImpl, calls } = captureFetch(() =>
      jsonResponse({ error: 'unauthorized' }, 401),
    );
    await expect(
      callCloudTool('share_session', {}, { fetchImpl, home }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    expect(calls.length).toBe(1);
    // Tokens file gone.
    expect(await readTokens(home)).toBeNull();
  });

  test('500 from cloud: throws non-AuthRequiredError, tokens preserved', async () => {
    await writeTokens(validTokens(), home);
    const { fetchImpl } = captureFetch(
      () =>
        new Response('internal boom', {
          status: 500,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    let caught: unknown;
    try {
      await callCloudTool('share_session', {}, { fetchImpl, home });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(AuthRequiredError);
    expect((caught as Error).message).toContain('500');
    // Tokens still on disk.
    const after = await readTokens(home);
    expect(after?.access_token).toBe('access-LIVE');
  });

  test('JSON-RPC error response: throws Error containing the cloud message', async () => {
    await writeTokens(validTokens(), home);
    const { fetchImpl } = captureFetch((req) =>
      rpcError((req.body as { id: string }).id, {
        code: -32602,
        message: 'bad input',
      }),
    );
    let caught: unknown;
    try {
      await callCloudTool('share_session', { bogus: true }, { fetchImpl, home });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(AuthRequiredError);
    expect((caught as Error).message).toContain('bad input');
    expect((caught as { cause?: { code?: number } }).cause?.code).toBe(-32602);
  });

  test('non-JSON 200 body: throws "cloud response was not valid JSON-RPC"', async () => {
    await writeTokens(validTokens(), home);
    const { fetchImpl } = captureFetch(
      () =>
        new Response('<html>not json</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    await expect(
      callCloudTool('share_session', {}, { fetchImpl, home }),
    ).rejects.toThrow('cloud response was not valid JSON-RPC');
  });

  test('JSON 200 body that is not a JSON-RPC envelope: throws "cloud response was not valid JSON-RPC"', async () => {
    await writeTokens(validTokens(), home);
    const { fetchImpl } = captureFetch(() =>
      jsonResponse({ totally: 'unrelated' }),
    );
    await expect(
      callCloudTool('share_session', {}, { fetchImpl, home }),
    ).rejects.toThrow('cloud response was not valid JSON-RPC');
  });

  test('each call gets a unique id', async () => {
    await writeTokens(validTokens(), home);
    const { fetchImpl, calls } = captureFetch((req) =>
      rpcSuccess((req.body as { id: string }).id, {}),
    );
    await callCloudTool('share_session', {}, { fetchImpl, home });
    await callCloudTool('share_session', {}, { fetchImpl, home });
    const ids = calls.map((c) => (c.body as { id: string }).id);
    expect(ids[0]).not.toBe(ids[1]);
  });

  test('getValidAccessToken is invoked exactly once per call in the happy path', async () => {
    await writeTokens(validTokens(), home);
    // Confirm by counting calls to a fetchImpl that includes the auth
    // header — one fetch ⇔ one token acquisition in this implementation.
    const { fetchImpl, calls } = captureFetch((req) =>
      rpcSuccess((req.body as { id: string }).id, { ok: true }),
    );
    await callCloudTool('get_thread', { id: 'x' }, { fetchImpl, home });
    expect(calls.length).toBe(1);
    expect(calls[0]!.headers['authorization']).toBe('Bearer access-LIVE');
  });
});
