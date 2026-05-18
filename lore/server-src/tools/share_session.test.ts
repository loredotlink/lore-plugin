import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runShareSession,
  shareSessionFromDisk,
  shareSessionTool,
  WATCHER_TIP,
} from './share_session';
import { AuthRequiredError, AUTH_REQUIRED_MESSAGE } from '../lib/errors';
import { writeTokens, readTokens, type Tokens } from '../lib/auth/store';
import { __resetCloudBaseUrlForTests } from '../lib/cloudBaseUrl';
import { __resetInFlightForTests } from '../lib/auth/refresh';
import { CoworkSource } from '../lib/session/cowork';
import { writePluginState, readPluginState } from '../lib/pluginState';

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
  let source: CoworkSource;
  beforeEach(() => {
    home = makeTmpHome();
    sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'share-session-root-'));
    source = new CoworkSource({ sessionsRoot });
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
      { fetchImpl, home, source, env: {} },
    );

    // Use toMatchObject so the optional _tip field (from watcher-soft-prompt)
    // does not break this test — the transcript-routing behavior is the
    // focus here.
    expect(result).toMatchObject(expected);
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
      { fetchImpl, home, source, env: {} },
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
      { fetchImpl, home, source, env: {} },
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
        source,
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
        { fetchImpl, home, source, env: {} },
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
        { fetchImpl, home, source, env: {} },
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
      { fetchImpl, home, source, env: {} },
    );
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: AUTH_REQUIRED_MESSAGE }],
    });
    expect(calls.length).toBe(0);
  });

  // ── Watcher soft-prompt tests ─────────────────────────────────────────────

  function makeSuccessFetch(): ReturnType<typeof captureFetch> {
    return captureFetch((req) =>
      rpcSuccess(req.body.id, { thread_id: 't_tip', thread_url: 'https://lore/t_tip' }),
    );
  }

  test('watcher tip is appended on the first share (share_count=0)', async () => {
    await writeTokens(validTokens(), home);
    stageSession('transcript-a');
    const { fetchImpl } = makeSuccessFetch();
    const result = await shareSessionFromDisk({}, { fetchImpl, home, source, env: {} });
    expect(result).toMatchObject({ thread_id: 't_tip', thread_url: 'https://lore/t_tip' });
    expect((result as Record<string, unknown>)._tip).toBe(WATCHER_TIP);
  });

  test('watcher tip is appended on the second share (share_count=1)', async () => {
    await writeTokens(validTokens(), home);
    await writePluginState({ share_count: 1, watcher_prompt_dismissed: false }, home);
    stageSession('transcript-b');
    const { fetchImpl } = makeSuccessFetch();
    const result = await shareSessionFromDisk({}, { fetchImpl, home, source, env: {} });
    expect((result as Record<string, unknown>)._tip).toBe(WATCHER_TIP);
  });

  test('watcher tip is appended on the third share (share_count=2)', async () => {
    await writeTokens(validTokens(), home);
    await writePluginState({ share_count: 2, watcher_prompt_dismissed: false }, home);
    stageSession('transcript-c');
    const { fetchImpl } = makeSuccessFetch();
    const result = await shareSessionFromDisk({}, { fetchImpl, home, source, env: {} });
    expect((result as Record<string, unknown>)._tip).toBe(WATCHER_TIP);
  });

  test('watcher tip is suppressed on the fourth share (share_count=3)', async () => {
    await writeTokens(validTokens(), home);
    await writePluginState({ share_count: 3, watcher_prompt_dismissed: false }, home);
    stageSession('transcript-d');
    const { fetchImpl } = makeSuccessFetch();
    const result = await shareSessionFromDisk({}, { fetchImpl, home, source, env: {} });
    expect((result as Record<string, unknown>)._tip).toBeUndefined();
  });

  test('watcher tip is suppressed when watcher_prompt_dismissed=true', async () => {
    await writeTokens(validTokens(), home);
    await writePluginState({ share_count: 0, watcher_prompt_dismissed: true }, home);
    stageSession('transcript-e');
    const { fetchImpl } = makeSuccessFetch();
    const result = await shareSessionFromDisk({}, { fetchImpl, home, source, env: {} });
    expect((result as Record<string, unknown>)._tip).toBeUndefined();
  });

  test('share_count increments on every successful share, including when tip is suppressed', async () => {
    await writeTokens(validTokens(), home);
    await writePluginState({ share_count: 3, watcher_prompt_dismissed: false }, home);
    stageSession('transcript-f');
    const { fetchImpl } = makeSuccessFetch();
    await shareSessionFromDisk({}, { fetchImpl, home, source, env: {} });
    const state = await readPluginState(home);
    expect(state.share_count).toBe(4);
  });

  test('share_count increments on every successful share, including when tip shows', async () => {
    await writeTokens(validTokens(), home);
    stageSession('transcript-g'); // share_count starts at 0
    const { fetchImpl } = makeSuccessFetch();
    await shareSessionFromDisk({}, { fetchImpl, home, source, env: {} });
    const state = await readPluginState(home);
    expect(state.share_count).toBe(1);
  });

  test('plugin state I/O error does not fail the share', async () => {
    await writeTokens(validTokens(), home);
    // Write a malformed state file so readPluginState throws.
    const p = require('../lib/pluginState').pluginStateFilePath(home);
    const parent = require('node:path').dirname(p);
    require('node:fs').mkdirSync(parent, { recursive: true });
    require('node:fs').writeFileSync(p, 'not-json');

    stageSession('transcript-h');
    const { fetchImpl } = makeSuccessFetch();
    // Should not throw; should still return the cloud result.
    const result = await shareSessionFromDisk({}, { fetchImpl, home, source, env: {} });
    expect(result).toMatchObject({ thread_id: 't_tip', thread_url: 'https://lore/t_tip' });
  });

  test('auth-required result does not increment share_count', async () => {
    // No tokens: share fails with auth-required, plugin state must not change.
    stageSession('transcript-i');
    const { fetchImpl } = makeSuccessFetch();
    await shareSessionFromDisk({}, { fetchImpl, home, source, env: {} });
    // File should not have been created (still at defaults).
    const state = await readPluginState(home);
    expect(state.share_count).toBe(0);
  });
});
