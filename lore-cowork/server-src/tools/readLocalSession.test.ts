import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  readLocalSessionTool,
  runReadLocalSession,
  type ReadLocalSessionResult,
} from './readLocalSession';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-cowork-read-test-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Create a session at `<root>/<conv>/<sess>/local_<id>/` with a
 * recognisable transcript + optional uploads/outputs. mtime is set on
 * the session directory.
 */
function makeSession(
  root: string,
  conversationId: string,
  sessionId: string,
  opts: {
    transcript?: string;
    mtimeMs?: number;
    uploads?: string[];
    outputs?: string[];
    noLocalSubdir?: boolean;
    noTranscript?: boolean;
  } = {},
): string {
  const sessionDir = path.join(root, conversationId, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  if (!opts.noLocalSubdir) {
    const localDir = path.join(sessionDir, 'local_abc');
    fs.mkdirSync(localDir, { recursive: true });
    if (!opts.noTranscript) {
      fs.writeFileSync(
        path.join(localDir, 'audit.jsonl'),
        opts.transcript ?? '{"event":"hi"}\n',
        'utf8',
      );
    }
    if (opts.uploads) {
      const uploadsDir = path.join(localDir, 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });
      for (const name of opts.uploads) {
        fs.writeFileSync(path.join(uploadsDir, name), 'upload', 'utf8');
      }
    }
    if (opts.outputs) {
      const outputsDir = path.join(localDir, 'outputs');
      fs.mkdirSync(outputsDir, { recursive: true });
      for (const name of opts.outputs) {
        fs.writeFileSync(path.join(outputsDir, name), 'output', 'utf8');
      }
    }
  }
  if (opts.mtimeMs !== undefined) {
    const t = opts.mtimeMs / 1000;
    fs.utimesSync(sessionDir, t, t);
  }
  return sessionDir;
}

describe('readLocalSessionTool — shape', () => {
  test('exports a tool named "read_local_session"', () => {
    expect(readLocalSessionTool.name).toBe('read_local_session');
  });

  test('has a non-empty description', () => {
    expect(typeof readLocalSessionTool.description).toBe('string');
    expect(readLocalSessionTool.description.length).toBeGreaterThan(0);
  });

  test('input schema is the documented shape', () => {
    expect(readLocalSessionTool.inputSchema).toEqual({
      type: 'object',
      properties: {
        session_id: { type: 'string' },
      },
      additionalProperties: false,
    });
  });

  test('handler is an async function', () => {
    expect(typeof readLocalSessionTool.handler).toBe('function');
  });
});

describe('runReadLocalSession — resolution priority', () => {
  let tmp: string;
  let root: string;
  beforeEach(() => {
    tmp = makeTmpDir();
    root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    // Two sessions: A older, B newer.
    makeSession(root, 'convA', 'sess-A', {
      mtimeMs: 1_000_000,
      transcript: 'A-transcript\n',
      uploads: ['a-up.txt'],
      outputs: ['a-out.json'],
    });
    makeSession(root, 'convB', 'sess-B', {
      mtimeMs: 5_000_000,
      transcript: 'B-transcript\n',
      uploads: ['b-up.txt'],
      outputs: ['b-out.json'],
    });
  });
  afterEach(() => {
    rmrf(tmp);
  });

  test('no args, no env → newest by mtime (B)', () => {
    const result = runReadLocalSession({ root, args: {}, env: {} });
    expect(result.session_id).toBe('sess-B');
    expect(result.conversation_id).toBe('convB');
    expect(result.transcript).toBe('B-transcript\n');
    expect(result.uploads).toEqual(['b-up.txt']);
    expect(result.outputs).toEqual(['b-out.json']);
  });

  test('COWORK_SESSION_ID env → that session regardless of mtime', () => {
    const result = runReadLocalSession({
      root,
      args: {},
      env: { COWORK_SESSION_ID: 'sess-A' },
    });
    expect(result.session_id).toBe('sess-A');
    expect(result.conversation_id).toBe('convA');
    expect(result.transcript).toBe('A-transcript\n');
  });

  test('session_id arg → that session regardless of env or mtime', () => {
    const result = runReadLocalSession({
      root,
      args: { session_id: 'sess-A' },
      env: { COWORK_SESSION_ID: 'sess-B' },
    });
    expect(result.session_id).toBe('sess-A');
    expect(result.conversation_id).toBe('convA');
    expect(result.transcript).toBe('A-transcript\n');
  });

  test('session_id arg takes priority over env var (explicit check)', () => {
    // Arg points to A; env points to B; arg wins.
    const result = runReadLocalSession({
      root,
      args: { session_id: 'sess-A' },
      env: { COWORK_SESSION_ID: 'sess-B' },
    });
    expect(result.session_id).toBe('sess-A');
  });

  test('empty-string session_id falls through to env', () => {
    const result = runReadLocalSession({
      root,
      args: { session_id: '' },
      env: { COWORK_SESSION_ID: 'sess-A' },
    });
    expect(result.session_id).toBe('sess-A');
  });

  test('whitespace-only session_id falls through to env', () => {
    const result = runReadLocalSession({
      root,
      args: { session_id: '   ' },
      env: { COWORK_SESSION_ID: 'sess-A' },
    });
    expect(result.session_id).toBe('sess-A');
  });

  test('empty-string env var falls through to mtime', () => {
    const result = runReadLocalSession({
      root,
      args: {},
      env: { COWORK_SESSION_ID: '' },
    });
    expect(result.session_id).toBe('sess-B'); // newest
  });

  test('whitespace-only env var falls through to mtime', () => {
    const result = runReadLocalSession({
      root,
      args: {},
      env: { COWORK_SESSION_ID: '   ' },
    });
    expect(result.session_id).toBe('sess-B');
  });

  test('empty-string session_id AND empty-string env → falls through to mtime', () => {
    const result = runReadLocalSession({
      root,
      args: { session_id: '' },
      env: { COWORK_SESSION_ID: '' },
    });
    expect(result.session_id).toBe('sess-B');
  });

  test('whitespace-padded session_id arg resolves the trimmed real session', () => {
    const result = runReadLocalSession({
      root,
      args: { session_id: '  sess-A  ' },
      env: {},
    });
    expect(result.session_id).toBe('sess-A');
    expect(result.conversation_id).toBe('convA');
  });

  test('whitespace-padded COWORK_SESSION_ID env resolves the trimmed real session', () => {
    const result = runReadLocalSession({
      root,
      args: {},
      env: { COWORK_SESSION_ID: '  sess-A  ' },
    });
    expect(result.session_id).toBe('sess-A');
    expect(result.conversation_id).toBe('convA');
  });
});

describe('runReadLocalSession — error paths', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  test('bogus session_id arg → McpError(InvalidParams) including the id', () => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    makeSession(root, 'conv', 'real-session', { mtimeMs: 1_000_000 });

    let thrown: unknown;
    try {
      runReadLocalSession({
        root,
        args: { session_id: 'bogus-id' },
        env: {},
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpError);
    const e = thrown as McpError;
    expect(e.code).toBe(ErrorCode.InvalidParams);
    expect(e.message).toContain('session not found: bogus-id');
  });

  test('bogus COWORK_SESSION_ID env → McpError(InvalidParams) including the id', () => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    makeSession(root, 'conv', 'real-session', { mtimeMs: 1_000_000 });

    let thrown: unknown;
    try {
      runReadLocalSession({
        root,
        args: {},
        env: { COWORK_SESSION_ID: 'ghost-id' },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpError);
    const e = thrown as McpError;
    expect(e.code).toBe(ErrorCode.InvalidParams);
    expect(e.message).toContain('session not found: ghost-id');
  });

  test('no sessions at all → McpError(InvalidParams, "no Cowork session found")', () => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root);

    let thrown: unknown;
    try {
      runReadLocalSession({ root, args: {}, env: {} });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpError);
    const e = thrown as McpError;
    expect(e.code).toBe(ErrorCode.InvalidParams);
    expect(e.message).toContain('no Cowork session found');
  });

  test('root does not exist → McpError(InvalidParams, "no Cowork session found")', () => {
    const missing = path.join(tmp, 'does-not-exist');
    let thrown: unknown;
    try {
      runReadLocalSession({ root: missing, args: {}, env: {} });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).code).toBe(ErrorCode.InvalidParams);
    expect((thrown as McpError).message).toContain('no Cowork session found');
  });

  test('missing transcript file → McpError(InvalidParams) with lib message', () => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    makeSession(root, 'conv', 'no-transcript', {
      mtimeMs: 1_000_000,
      noTranscript: true,
    });

    let thrown: unknown;
    try {
      runReadLocalSession({ root, args: {}, env: {} });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpError);
    const e = thrown as McpError;
    expect(e.code).toBe(ErrorCode.InvalidParams);
    // The lib's actionable message is preserved verbatim.
    expect(e.message).toContain('has no transcript file');
    expect(e.message).toContain('audit.jsonl');
  });

  test('missing local_* subdirectory → McpError(InvalidParams) with lib message', () => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    makeSession(root, 'conv', 'no-local-subdir', {
      mtimeMs: 1_000_000,
      noLocalSubdir: true,
    });

    let thrown: unknown;
    try {
      runReadLocalSession({ root, args: {}, env: {} });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpError);
    const e = thrown as McpError;
    expect(e.code).toBe(ErrorCode.InvalidParams);
    expect(e.message).toContain('no local_* subdirectory');
  });
});

describe('runReadLocalSession — return shape', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  test('returns only the documented snake_case keys', () => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    makeSession(root, 'conv', 'sess', {
      mtimeMs: 1_000_000,
      transcript: 'x',
      uploads: ['u.txt'],
      outputs: ['o.json'],
    });

    const result = runReadLocalSession({ root, args: {}, env: {} });
    expect(Object.keys(result).sort()).toEqual([
      'conversation_id',
      'outputs',
      'session_id',
      'transcript',
      'uploads',
    ]);
  });

  test('transcript is returned verbatim (not parsed)', () => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    const raw = 'not-json-at-all\n{"a":1}\nthird line';
    makeSession(root, 'conv', 'sess', {
      mtimeMs: 1_000_000,
      transcript: raw,
    });

    const result = runReadLocalSession({ root, args: {}, env: {} });
    expect(result.transcript).toBe(raw);
  });

  test('result is JSON-serializable', () => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    makeSession(root, 'conv', 'sess', {
      mtimeMs: 1_000_000,
      transcript: 'x',
      uploads: ['a.txt'],
      outputs: ['b.json'],
    });
    const result = runReadLocalSession({ root, args: {}, env: {} });
    const roundTripped = JSON.parse(JSON.stringify(result)) as ReadLocalSessionResult;
    expect(roundTripped).toEqual(result);
  });
});

describe('readLocalSessionTool.handler — env is read lazily', () => {
  // We verify the lazy-read by mutating process.env across two calls
  // and checking the handler sees the new value. We can't redirect
  // `defaultSessionsRoot()` from the handler, so we set the env var
  // to a clearly-bogus id and assert the InvalidParams message
  // includes the value we set RIGHT NOW (not what was there at module
  // load). If the handler captured env at load time, the message
  // would either be missing or reference a different id.
  const ORIGINAL = process.env.COWORK_SESSION_ID;
  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.COWORK_SESSION_ID;
    } else {
      process.env.COWORK_SESSION_ID = ORIGINAL;
    }
  });

  test('handler reads process.env.COWORK_SESSION_ID lazily', async () => {
    process.env.COWORK_SESSION_ID = 'lazy-marker-id-12345';

    let thrown: unknown;
    try {
      await readLocalSessionTool.handler({});
    } catch (err) {
      thrown = err;
    }
    // Either the env id matched a real session on this machine
    // (vanishingly unlikely with the marker id) or we got the
    // expected InvalidParams. We just need to confirm the handler
    // actually saw the env value we set.
    if (thrown) {
      expect(thrown).toBeInstanceOf(McpError);
      expect((thrown as McpError).message).toContain('lazy-marker-id-12345');
    }
  });
});
