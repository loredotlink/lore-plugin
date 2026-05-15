import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runShareSession, shareSessionTool } from './share_session';
import { AuthRequiredError, AUTH_REQUIRED_MESSAGE } from '../lib/errors';
import { writeTokens, readTokens, type Tokens } from '../lib/tokens';
import { __resetCloudBaseUrlForTests } from '../lib/cloudBaseUrl';
import { __resetInFlightForTests } from '../lib/refresh';

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'share-session-test-'));
}
function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
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

interface Captured {
  url: string;
  body: { id: string; params: { name: string; arguments: unknown } };
}

function captureFetch(
  responder: (req: Captured) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (
    url: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const body = JSON.parse(init?.body as string);
    const cap: Captured = { url: String(url), body };
    calls.push(cap);
    return responder(cap);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('share_session tool', () => {
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

  test('happy path: returns cloud result and merges harness=cowork into args', async () => {
    await writeTokens(validTokens(), home);
    const expected = { thread_id: 't_abc', thread_url: 'https://lore/t_abc' };
    const { fetchImpl, calls } = captureFetch((req) =>
      rpcSuccess(req.body.id, expected),
    );
    const result = await runShareSession(
      { transcript: 'hello world' },
      { fetchImpl, home },
    );
    expect(result).toEqual(expected);
    expect(calls[0]!.body.params.name).toBe('share_session');
    expect(calls[0]!.body.params.arguments).toEqual({
      transcript: 'hello world',
      harness: 'cowork',
    });
  });

  test('plugin-supplied harness wins over caller-supplied harness', async () => {
    // Caller cannot do this via the schema (additionalProperties: false),
    // but the pure core spreads in the safe order even when called
    // directly. Lock the contract.
    await writeTokens(validTokens(), home);
    const { fetchImpl, calls } = captureFetch((req) =>
      rpcSuccess(req.body.id, { thread_id: 'x', thread_url: 'y' }),
    );
    await runShareSession(
      { transcript: 't', harness: 'something_else' } as Record<
        string,
        unknown
      >,
      { fetchImpl, home },
    );
    expect(
      (calls[0]!.body.params.arguments as { harness: string }).harness,
    ).toBe('cowork');
  });

  test('no tokens on disk → returns authRequiredToMcpError shape', async () => {
    const { fetchImpl, calls } = captureFetch(() => jsonResponse({}));
    const result = await runShareSession(
      { transcript: 't' },
      { fetchImpl, home },
    );
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: AUTH_REQUIRED_MESSAGE }],
    });
    // No fetch issued since getValidAccessToken short-circuited.
    expect(calls.length).toBe(0);
  });

  test('cloud 401 → tokens deleted and auth-required result returned', async () => {
    await writeTokens(validTokens(), home);
    const { fetchImpl } = captureFetch(() =>
      jsonResponse({ error: 'unauthorized' }, 401),
    );
    const result = await runShareSession(
      { transcript: 't' },
      { fetchImpl, home },
    );
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: AUTH_REQUIRED_MESSAGE }],
    });
    expect(await readTokens(home)).toBeNull();
  });

  test('cloud JSON-RPC error (e.g. workspace_required) → re-throws', async () => {
    await writeTokens(validTokens(), home);
    const { fetchImpl } = captureFetch((req) =>
      jsonResponse({
        jsonrpc: '2.0',
        id: req.body.id,
        error: { code: -32602, message: 'workspace_required' },
      }),
    );
    let caught: unknown;
    try {
      await runShareSession({ transcript: 't' }, { fetchImpl, home });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(AuthRequiredError);
    expect((caught as Error).message).toContain('workspace_required');
  });

  test('input schema does not expose `harness` as a property', () => {
    expect(shareSessionTool.inputSchema.properties).toBeDefined();
    expect(
      Object.keys(shareSessionTool.inputSchema.properties!),
    ).not.toContain('harness');
    expect(shareSessionTool.inputSchema.additionalProperties).toBe(false);
  });
});
