import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mcpTextCallToolResultSchema,
  type McpTextCallToolResult,
} from '@lore/contracts/mcp';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthRequiredError } from './errors';
import { callCloudTool } from './cloudCall';
import { __resetInFlightForTests } from './auth/refresh';
import {
  writeTokens,
  readTokens,
  type Tokens,
} from './auth/store';
import { __resetCloudBaseUrlForTests } from './cloudBaseUrl';
import {
  discoverEndpoints,
  __resetInFlightForTests as __resetDiscoveryInFlightForTests,
} from './auth/discovery';

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-cloudcall-test-'));
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

function textToolResult(payload: unknown): McpTextCallToolResult {
  return mcpTextCallToolResultSchema.parse({
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  });
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

// ---------------------------------------------------------------------------
// 401 retry-before-delete helpers
//
// A cloud 401 must NOT immediately delete the session. cloudCall forces one
// credential refresh and retries the /mcp call once, threading the injected
// `fetchImpl` through the refresh so tests stay hermetic. These helpers mock
// the token endpoint (and PRM/AS, though the discovery cache is primed so the
// call under test only hits the token endpoint + /mcp).
// ---------------------------------------------------------------------------
const TEST_PRM_URL_FRAGMENT = 'oauth-protected-resource';
const TEST_AS_URL_FRAGMENT = 'oauth-authorization-server';
const TEST_TOKEN_ENDPOINT = 'https://signin.lore.tanagram.ai/oauth2/token';
const MCP_PROXY_URL = 'http://localhost:4000/mcp';

function prmBody() {
  return {
    resource: 'https://api.lore.tanagram.ai',
    authorization_servers: ['https://signin.lore.tanagram.ai'],
  };
}
function asBody() {
  return { issuer: 'https://signin.lore.tanagram.ai', token_endpoint: TEST_TOKEN_ENDPOINT };
}
function refreshBody(overrides: Record<string, unknown> = {}) {
  return {
    access_token: 'access-REFRESHED',
    refresh_token: 'refresh-REFRESHED',
    expires_in: 3600,
    token_type: 'Bearer',
    scope: 'mcp.read mcp.write',
    ...overrides,
  };
}

// Prime the on-disk discovery cache so the forced refresh in the call under
// test only needs the token endpoint (not PRM/AS).
async function primeDiscoveryCache(h: string): Promise<void> {
  const primeFetch = (async (url: string) => {
    const s = String(url);
    if (s.includes(TEST_PRM_URL_FRAGMENT)) return jsonResponse(prmBody());
    if (s.includes(TEST_AS_URL_FRAGMENT)) return jsonResponse(asBody());
    throw new Error(`prime fetch unexpected URL: ${s}`);
  }) as unknown as typeof fetch;
  await discoverEndpoints({ fetchImpl: primeFetch, home: h });
  __resetDiscoveryInFlightForTests();
}

// A fetch that returns a scripted status sequence for successive /mcp calls,
// serves the token endpoint for the forced refresh, and records both.
function makeRetryFetch(opts: {
  mcpStatuses: number[];
  mcpResult?: unknown;
  tokenResponder?: () => Response;
}): { fetchImpl: typeof fetch; mcpCalls: CapturedRequest[]; tokenCalls: () => number } {
  const mcpCalls: CapturedRequest[] = [];
  let tokenCalls = 0;
  const fetchImpl = (async (url: string, init?: RequestInit): Promise<Response> => {
    const s = String(url);
    if (s === MCP_PROXY_URL) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      mcpCalls.push({ url: s, method: init?.method, headers, body });
      const idx = mcpCalls.length - 1;
      const status =
        opts.mcpStatuses[idx] ?? opts.mcpStatuses[opts.mcpStatuses.length - 1] ?? 200;
      if (status === 200) {
        return rpcSuccess(
          (body as { id: string }).id,
          opts.mcpResult ?? textToolResult({ ok: true }),
        );
      }
      return jsonResponse({ error: 'unauthorized' }, status);
    }
    if (s === TEST_TOKEN_ENDPOINT) {
      tokenCalls += 1;
      return opts.tokenResponder ? opts.tokenResponder() : jsonResponse(refreshBody());
    }
    if (s.includes(TEST_PRM_URL_FRAGMENT)) return jsonResponse(prmBody());
    if (s.includes(TEST_AS_URL_FRAGMENT)) return jsonResponse(asBody());
    throw new Error(`retry fetch unexpected URL: ${s}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, mcpCalls, tokenCalls: () => tokenCalls };
}

describe('callCloudTool', () => {
  let home: string;
  beforeEach(() => {
    home = makeTmpHome();
    __resetInFlightForTests();
    __resetDiscoveryInFlightForTests();
    process.env.LORE_MCP_PROXY_BASE_URL = 'http://localhost:4000';
    process.env.LORE_MCP_BASE_URL = 'https://mcp.lore.tanagram.ai';
    __resetCloudBaseUrlForTests();
  });
  afterEach(() => {
    rmrf(home);
    delete process.env.LORE_MCP_PROXY_BASE_URL;
    delete process.env.LORE_MCP_BASE_URL;
    __resetCloudBaseUrlForTests();
    __resetInFlightForTests();
    __resetDiscoveryInFlightForTests();
  });

  test('happy path: returns result, sends bearer + content-type, POSTs to /mcp', async () => {
    await writeTokens(validTokens(), home);
    const expectedResult = textToolResult({
      thread_id: 't_123',
      thread_url: 'https://lore/x',
    });
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

  test('cloud 401 then success: forces one refresh, retries once, tokens preserved (not deleted)', async () => {
    await writeTokens(validTokens(), home);
    await primeDiscoveryCache(home);
    const { fetchImpl, mcpCalls, tokenCalls } = makeRetryFetch({
      mcpStatuses: [401, 200],
      mcpResult: textToolResult({ thread_id: 't_ok' }),
    });
    const result = await callCloudTool('share_session', {}, { fetchImpl, home });
    expect(result).toEqual(textToolResult({ thread_id: 't_ok' }));
    // Exactly one retry: first call 401 with the live token, retry with the
    // refreshed token.
    expect(mcpCalls.length).toBe(2);
    expect(mcpCalls[0]!.headers['authorization']).toBe('Bearer access-LIVE');
    expect(mcpCalls[1]!.headers['authorization']).toBe('Bearer access-REFRESHED');
    expect(tokenCalls()).toBe(1);
    // A single transient 401 must NEVER wipe the session.
    const after = await readTokens(home);
    expect(after?.access_token).toBe('access-REFRESHED');
  });

  test('cloud 401 twice (even after a successful refresh): deletes tokens and throws AuthRequiredError', async () => {
    await writeTokens(validTokens(), home);
    await primeDiscoveryCache(home);
    const { fetchImpl, mcpCalls, tokenCalls } = makeRetryFetch({ mcpStatuses: [401, 401] });
    await expect(
      callCloudTool('share_session', {}, { fetchImpl, home }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    // Refreshed once, retried once, still 401 → confirmed revocation.
    expect(mcpCalls.length).toBe(2);
    expect(tokenCalls()).toBe(1);
    expect(await readTokens(home)).toBeNull();
  });

  test('cloud 401 then a transient refresh failure: tokens preserved, no retry, not AuthRequiredError', async () => {
    await writeTokens(validTokens(), home);
    await primeDiscoveryCache(home);
    const { fetchImpl, mcpCalls } = makeRetryFetch({
      mcpStatuses: [401],
      tokenResponder: () => jsonResponse({ error: 'server_error' }, 503),
    });
    let caught: unknown;
    try {
      await callCloudTool('share_session', {}, { fetchImpl, home });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    // A failed refresh is transient — it must not delete the session or be
    // reported as auth-required (which would prompt a needless re-login).
    expect(caught).not.toBeInstanceOf(AuthRequiredError);
    const after = await readTokens(home);
    expect(after?.access_token).toBe('access-LIVE');
    // No retry when there is no fresh token to retry with.
    expect(mcpCalls.length).toBe(1);
  });

  test('cloud 401 then invalid_grant on refresh: deletes tokens and throws AuthRequiredError', async () => {
    await writeTokens(validTokens(), home);
    await primeDiscoveryCache(home);
    const { fetchImpl, mcpCalls } = makeRetryFetch({
      mcpStatuses: [401],
      tokenResponder: () => jsonResponse({ error: 'invalid_grant' }, 400),
    });
    await expect(
      callCloudTool('share_session', {}, { fetchImpl, home }),
    ).rejects.toBeInstanceOf(AuthRequiredError);
    // A dead refresh token is a confirmed revocation → session cleared.
    expect(await readTokens(home)).toBeNull();
    expect(mcpCalls.length).toBe(1);
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

  test('raw JSON-RPC result without the MCP content envelope is rejected', async () => {
    await writeTokens(validTokens(), home);
    const { fetchImpl } = captureFetch((req) =>
      rpcSuccess((req.body as { id: string }).id, {
        thread_id: 't_raw',
        thread_url: 'https://lore/t_raw',
      }),
    );
    await expect(
      callCloudTool('share_session', {}, { fetchImpl, home }),
    ).rejects.toThrow('cloud response was not a valid MCP tool result');
  });

  test('each call gets a unique id', async () => {
    await writeTokens(validTokens(), home);
    const { fetchImpl, calls } = captureFetch((req) =>
      rpcSuccess((req.body as { id: string }).id, textToolResult({})),
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
      rpcSuccess((req.body as { id: string }).id, textToolResult({ ok: true })),
    );
    await callCloudTool('get_thread', { id: 'x' }, { fetchImpl, home });
    expect(calls.length).toBe(1);
    expect(calls[0]!.headers['authorization']).toBe('Bearer access-LIVE');
  });
});
