import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloudProxyTools, runCloudProxyTool } from './cloudProxyTools';
import { AuthRequiredError, AUTH_REQUIRED_MESSAGE } from '../lib/errors';
import { writeTokens, readTokens, type Tokens } from '../lib/auth/store';
import { __resetCloudBaseUrlForTests } from '../lib/cloudBaseUrl';
import { __resetInFlightForTests } from '../lib/auth/refresh';

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-proxy-tools-test-'));
}
function rmrf(d: string) {
  fs.rmSync(d, { recursive: true, force: true });
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

describe('generated cloud proxy tools', () => {
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

  test('derives the proxy tool list and schemas from shared specs', () => {
    expect(cloudProxyTools.map((tool) => tool.name)).toEqual([
      'list_threads',
      'get_thread',
      'search_threads',
    ]);

    const listThreadsTool = cloudProxyTools.find((tool) => tool.name === 'list_threads')!;
    const listProps = listThreadsTool.inputSchema.properties!;
    expect((listProps.before as { type: string }).type).toBe('string');
    expect((listProps.after as { type: string }).type).toBe('string');
    expect((listProps.author_ids as { type: string }).type).toBe('string');
    expect(listThreadsTool.inputSchema.additionalProperties).toBe(false);
    expect(listThreadsTool.inputSchema.required).toBeUndefined();

    const getThreadTool = cloudProxyTools.find((tool) => tool.name === 'get_thread')!;
    expect(getThreadTool.inputSchema.required).toEqual(['thread_id']);
    expect(getThreadTool.inputSchema.properties).toHaveProperty('thread_id');

    const searchThreadsTool = cloudProxyTools.find((tool) => tool.name === 'search_threads')!;
    expect(searchThreadsTool.inputSchema.required).toEqual(['query']);
    expect(searchThreadsTool.inputSchema.additionalProperties).toBe(false);
  });

  test('happy path: returns cloud result verbatim', async () => {
    await writeTokens(validTokens(), home);
    const expected = { id: 't_1', body: 'thread contents' };
    const fetchImpl = (async (_: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { id: string };
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: expected });
    }) as unknown as typeof fetch;
    const result = await runCloudProxyTool('get_thread', { thread_id: 't_1' }, { fetchImpl, home });
    expect(result).toEqual(expected);
  });

  test('passes arguments through to the cloud verbatim', async () => {
    await writeTokens(validTokens(), home);
    let capturedArgs: unknown;
    const fetchImpl = (async (_: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as {
        id: string;
        params: { arguments: unknown };
      };
      capturedArgs = body.params.arguments;
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: { threads: [] },
      });
    }) as unknown as typeof fetch;
    await runCloudProxyTool(
      'search_threads',
      { query: 'oauth device flow', limit: 25 },
      { fetchImpl, home },
    );
    expect(capturedArgs).toEqual({ query: 'oauth device flow', limit: 25 });
  });

  test('no tokens → auth-required result', async () => {
    const fetchImpl = (async () => jsonResponse({})) as unknown as typeof fetch;
    const result = await runCloudProxyTool('list_threads', {}, { fetchImpl, home });
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: AUTH_REQUIRED_MESSAGE }],
    });
  });

  test('cloud 401 → tokens deleted + auth-required result', async () => {
    await writeTokens(validTokens(), home);
    const fetchImpl = (async () =>
      jsonResponse({ error: 'unauthorized' }, 401)) as unknown as typeof fetch;
    const result = await runCloudProxyTool('get_thread', { thread_id: 'x' }, { fetchImpl, home });
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: AUTH_REQUIRED_MESSAGE }],
    });
    expect(await readTokens(home)).toBeNull();
  });

  test('non-auth cloud error re-throws', async () => {
    await writeTokens(validTokens(), home);
    const fetchImpl = (async (_: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { id: string };
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32602, message: 'thread_not_found' },
      });
    }) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await runCloudProxyTool('get_thread', { thread_id: 'missing' }, { fetchImpl, home });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(AuthRequiredError);
    expect((caught as Error).message).toContain('thread_not_found');
  });
});
