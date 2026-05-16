import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runShareSession,
  shareSessionFromDisk,
  shareSessionTool,
} from './share_session';
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

  test('input schema exposes only `session_id` — not `harness`, not `transcript`', () => {
    // The agent's contract is "tell me which session, if any" — the
    // plugin handles the read internally. Exposing `transcript`
    // would re-introduce the round-trip-through-agent-context bug
    // that motivated the local-resolve refactor.
    expect(shareSessionTool.inputSchema.properties).toBeDefined();
    const propertyNames = Object.keys(
      shareSessionTool.inputSchema.properties!,
    );
    expect(propertyNames).toEqual(['session_id']);
    expect(shareSessionTool.inputSchema.additionalProperties).toBe(false);
    expect(shareSessionTool.inputSchema.required ?? []).toEqual([]);
  });
});

describe('shareSessionFromDisk', () => {
  let home: string;
  let sessionsRoot: string;
  beforeEach(() => {
    home = makeTmpHome();
    sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'share-session-root-'));
    __resetInFlightForTests();
    process.env.LORE_MCP_BASE_URL = 'http://localhost:4000';
    __resetCloudBaseUrlForTests();
  });
  afterEach(() => {
    rmrf(home);
    rmrf(sessionsRoot);
    delete process.env.LORE_MCP_BASE_URL;
    __resetCloudBaseUrlForTests();
    __resetInFlightForTests();
  });

  /**
   * Stage a session layout matching the real Cowork on-disk shape:
   *   <root>/<convId>/<sessId>/local_<id>/audit.jsonl
   * Returns the staged session_id.
   */
  function stageSession(
    transcript: string,
    convId = 'conv-A',
    sessId = 'sess-A',
    localId = 'local-A',
  ): string {
    const sessionDir = path.join(sessionsRoot, convId, sessId);
    const innerDir = path.join(sessionDir, `local_${localId}`);
    fs.mkdirSync(innerDir, { recursive: true });
    fs.writeFileSync(path.join(innerDir, 'audit.jsonl'), transcript);
    return sessId;
  }

  test('happy path: reads transcript from disk and forwards to cloud — agent never sees transcript bytes', async () => {
    await writeTokens(validTokens(), home);
    const transcriptBytes = 'envelope-wrapped-jsonl-line-1\nenvelope-line-2\n';
    stageSession(transcriptBytes);

    const expected = { thread_id: 't_42', thread_url: 'https://lore/t_42' };
    const { fetchImpl, calls } = captureFetch((req) =>
      rpcSuccess(req.body.id, expected),
    );

    const result = await shareSessionFromDisk(
      {},
      { fetchImpl, home, sessionsRoot, env: {} },
    );

    expect(result).toEqual(expected);
    // The transcript bytes were read locally and piped straight to
    // the cloud — they appear in the outbound RPC, never in the
    // function's return value.
    expect(calls.length).toBe(1);
    expect(calls[0]!.body.params.name).toBe('share_session');
    expect(calls[0]!.body.params.arguments).toEqual({
      transcript: transcriptBytes,
      harness: 'cowork',
    });
  });

  test('explicit session_id arg picks that session', async () => {
    await writeTokens(validTokens(), home);
    stageSession('older-transcript', 'conv-A', 'sess-old', 'local-old');
    stageSession('newer-transcript', 'conv-A', 'sess-new', 'local-new');

    const { fetchImpl, calls } = captureFetch((req) =>
      rpcSuccess(req.body.id, { thread_id: 'x', thread_url: 'y' }),
    );
    await shareSessionFromDisk(
      { session_id: 'sess-old' },
      { fetchImpl, home, sessionsRoot, env: {} },
    );
    expect(
      (calls[0]!.body.params.arguments as { transcript: string }).transcript,
    ).toBe('older-transcript');
  });

  test('no session_id and no env → resolves newest by mtime', async () => {
    await writeTokens(validTokens(), home);
    stageSession('older-transcript', 'conv-A', 'sess-old', 'local-old');
    // Force a measurable mtime gap so the newer session wins
    // regardless of filesystem timestamp granularity.
    const oldDir = path.join(sessionsRoot, 'conv-A', 'sess-old');
    const past = new Date(Date.now() - 10_000);
    fs.utimesSync(oldDir, past, past);
    stageSession('newer-transcript', 'conv-A', 'sess-new', 'local-new');

    const { fetchImpl, calls } = captureFetch((req) =>
      rpcSuccess(req.body.id, { thread_id: 'x', thread_url: 'y' }),
    );
    await shareSessionFromDisk(
      {},
      { fetchImpl, home, sessionsRoot, env: {} },
    );
    expect(
      (calls[0]!.body.params.arguments as { transcript: string }).transcript,
    ).toBe('newer-transcript');
  });

  test('COWORK_SESSION_ID env wins over newest-by-mtime when no arg', async () => {
    await writeTokens(validTokens(), home);
    stageSession('env-pick', 'conv-A', 'sess-env', 'local-env');
    const envDir = path.join(sessionsRoot, 'conv-A', 'sess-env');
    const past = new Date(Date.now() - 10_000);
    fs.utimesSync(envDir, past, past);
    stageSession('newer-transcript', 'conv-A', 'sess-new', 'local-new');

    const { fetchImpl, calls } = captureFetch((req) =>
      rpcSuccess(req.body.id, { thread_id: 'x', thread_url: 'y' }),
    );
    await shareSessionFromDisk(
      {},
      {
        fetchImpl,
        home,
        sessionsRoot,
        env: { COWORK_SESSION_ID: 'sess-env' },
      },
    );
    expect(
      (calls[0]!.body.params.arguments as { transcript: string }).transcript,
    ).toBe('env-pick');
  });

  test('no sessions on disk → throws InvalidParams (propagated from runReadLocalSession)', async () => {
    await writeTokens(validTokens(), home);
    const { fetchImpl, calls } = captureFetch(() => jsonResponse({}));

    let caught: unknown;
    try {
      await shareSessionFromDisk(
        {},
        { fetchImpl, home, sessionsRoot, env: {} },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('no Cowork session found');
    // We never reached the cloud call.
    expect(calls.length).toBe(0);
  });

  test('explicit session_id that does not exist → throws InvalidParams', async () => {
    await writeTokens(validTokens(), home);
    stageSession('some-transcript');

    const { fetchImpl, calls } = captureFetch(() => jsonResponse({}));
    let caught: unknown;
    try {
      await shareSessionFromDisk(
        { session_id: 'nope' },
        { fetchImpl, home, sessionsRoot, env: {} },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('session not found: nope');
    expect(calls.length).toBe(0);
  });

  test('cloud auth-required still surfaces through the orchestration layer', async () => {
    // No tokens written → getValidAccessToken short-circuits inside
    // runShareSession, which returns the auth-required shape. The
    // orchestration layer must pass it through unchanged.
    stageSession('some-transcript');
    const { fetchImpl, calls } = captureFetch(() => jsonResponse({}));
    const result = await shareSessionFromDisk(
      {},
      { fetchImpl, home, sessionsRoot, env: {} },
    );
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: AUTH_REQUIRED_MESSAGE }],
    });
    expect(calls.length).toBe(0);
  });
});
