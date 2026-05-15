import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSearchThreads, searchThreadsTool } from './search_threads';
import { AUTH_REQUIRED_MESSAGE } from '../lib/errors';
import { writeTokens, type Tokens } from '../lib/tokens';
import { __resetCloudBaseUrlForTests } from '../lib/cloudBaseUrl';
import { __resetInFlightForTests } from '../lib/refresh';

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'search-threads-test-'));
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

describe('search_threads tool', () => {
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

  test('happy path: returns cloud result verbatim', async () => {
    await writeTokens(validTokens(), home);
    const expected = { threads: [{ id: 't1', title: 'OAuth plan' }] };
    const fetchImpl = (async (_: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { id: string };
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: expected });
    }) as unknown as typeof fetch;
    const result = await runSearchThreads(
      { query: 'oauth', limit: 10 },
      { fetchImpl, home },
    );
    expect(result).toEqual(expected);
  });

  test('passes query and limit through to the cloud verbatim', async () => {
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
    await runSearchThreads({ query: 'oauth device flow', limit: 25 }, { fetchImpl, home });
    expect(capturedArgs).toEqual({ query: 'oauth device flow', limit: 25 });
  });

  test('no tokens → auth-required result', async () => {
    const fetchImpl = (async () => jsonResponse({})) as unknown as typeof fetch;
    const result = await runSearchThreads({ query: 'oauth' }, { fetchImpl, home });
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: AUTH_REQUIRED_MESSAGE }],
    });
  });

  test('input schema requires query and keeps limit optional', () => {
    const props = searchThreadsTool.inputSchema.properties!;
    expect((props.query as { type: string }).type).toBe('string');
    expect((props.limit as { type: string }).type).toBe('integer');
    expect(searchThreadsTool.inputSchema.required).toEqual(['query']);
    expect(searchThreadsTool.inputSchema.additionalProperties).toBe(false);
  });
});
