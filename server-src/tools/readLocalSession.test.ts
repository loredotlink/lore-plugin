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
import { CoworkSource } from '../lib/session/cowork.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-read-test-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Create a session at `<root>/<account>/<org>/local_<session>/` with a
 * recognisable transcript + optional uploads/outputs. mtime is set on the
 * transcript file (falling back to the `local_*` directory) to match what
 * `listCoworkSessions` actually orders on — setting it on the `<account>/<org>`
 * directory would be ignored and leave ordering at the mercy of real write
 * times, which tie under coarse-granularity filesystems in CI.
 */
function makeSession(
  root: string,
  accountId: string,
  orgId: string,
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
  const sessionDir = path.join(root, accountId, orgId);
  fs.mkdirSync(sessionDir, { recursive: true });
  if (!opts.noLocalSubdir) {
    const localDir = path.join(sessionDir, `local_${sessionId}`);
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
    // Order is determined by the transcript file's mtime, falling back to the
    // `local_*` directory's mtime (see listCoworkSessions). Set it on whichever
    // the implementation will read.
    const localDir = path.join(sessionDir, `local_${sessionId}`);
    const transcriptPath = path.join(localDir, 'audit.jsonl');
    if (!opts.noLocalSubdir && !opts.noTranscript) {
      fs.utimesSync(transcriptPath, t, t);
    } else if (!opts.noLocalSubdir) {
      fs.utimesSync(localDir, t, t);
    } else {
      fs.utimesSync(sessionDir, t, t);
    }
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
  let source: CoworkSource;
  beforeEach(() => {
    tmp = makeTmpDir();
    root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    source = new CoworkSource({ sessionsRoot: root });
    // Two sessions: A older, B newer.
    makeSession(root, 'accountA', 'org-A', 'sess-A', {
      mtimeMs: 1_000_000,
      transcript: 'A-transcript\n',
      uploads: ['a-up.txt'],
      outputs: ['a-out.json'],
    });
    makeSession(root, 'accountB', 'org-B', 'sess-B', {
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
    const result = runReadLocalSession({ source, args: {}, env: {} });
    expect(result.session_id).toBe('sess-B');
    expect(result.account_id).toBe('accountB');
    expect(result.org_id).toBe('org-B');
    expect(result.transcript).toBe('B-transcript\n');
    expect(result.uploads).toEqual(['b-up.txt']);
    expect(result.outputs).toEqual(['b-out.json']);
  });

  test('COWORK_SESSION_ID env → that session regardless of mtime', () => {
    const result = runReadLocalSession({
      source,
      args: {},
      env: { COWORK_SESSION_ID: 'sess-A' },
    });
    expect(result.session_id).toBe('sess-A');
    expect(result.account_id).toBe('accountA');
    expect(result.org_id).toBe('org-A');
    expect(result.transcript).toBe('A-transcript\n');
  });

  test('session_id arg → that session regardless of env or mtime', () => {
    const result = runReadLocalSession({
      source,
      args: { session_id: 'sess-A' },
      env: { COWORK_SESSION_ID: 'sess-B' },
    });
    expect(result.session_id).toBe('sess-A');
    expect(result.account_id).toBe('accountA');
    expect(result.transcript).toBe('A-transcript\n');
  });

  test('session_id arg takes priority over env var (explicit check)', () => {
    // Arg points to A; env points to B; arg wins.
    const result = runReadLocalSession({
      source,
      args: { session_id: 'sess-A' },
      env: { COWORK_SESSION_ID: 'sess-B' },
    });
    expect(result.session_id).toBe('sess-A');
  });

  test('empty-string session_id falls through to env', () => {
    const result = runReadLocalSession({
      source,
      args: { session_id: '' },
      env: { COWORK_SESSION_ID: 'sess-A' },
    });
    expect(result.session_id).toBe('sess-A');
  });

  test('whitespace-only session_id falls through to env', () => {
    const result = runReadLocalSession({
      source,
      args: { session_id: '   ' },
      env: { COWORK_SESSION_ID: 'sess-A' },
    });
    expect(result.session_id).toBe('sess-A');
  });

  test('empty-string env var falls through to mtime', () => {
    const result = runReadLocalSession({
      source,
      args: {},
      env: { COWORK_SESSION_ID: '' },
    });
    expect(result.session_id).toBe('sess-B'); // newest
  });

  test('whitespace-only env var falls through to mtime', () => {
    const result = runReadLocalSession({
      source,
      args: {},
      env: { COWORK_SESSION_ID: '   ' },
    });
    expect(result.session_id).toBe('sess-B');
  });

  test('empty-string session_id AND empty-string env → falls through to mtime', () => {
    const result = runReadLocalSession({
      source,
      args: { session_id: '' },
      env: { COWORK_SESSION_ID: '' },
    });
    expect(result.session_id).toBe('sess-B');
  });

  test('whitespace-padded session_id arg resolves the trimmed real session', () => {
    const result = runReadLocalSession({
      source,
      args: { session_id: '  sess-A  ' },
      env: {},
    });
    expect(result.session_id).toBe('sess-A');
    expect(result.account_id).toBe('accountA');
  });

  test('whitespace-padded COWORK_SESSION_ID env resolves the trimmed real session', () => {
    const result = runReadLocalSession({
      source,
      args: {},
      env: { COWORK_SESSION_ID: '  sess-A  ' },
    });
    expect(result.session_id).toBe('sess-A');
    expect(result.account_id).toBe('accountA');
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
    makeSession(root, 'account', 'org', 'real-session', { mtimeMs: 1_000_000 });
    const source = new CoworkSource({ sessionsRoot: root });

    let thrown: unknown;
    try {
      runReadLocalSession({
        source,
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
    makeSession(root, 'account', 'org', 'real-session', { mtimeMs: 1_000_000 });
    const source = new CoworkSource({ sessionsRoot: root });

    let thrown: unknown;
    try {
      runReadLocalSession({
        source,
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
    const source = new CoworkSource({ sessionsRoot: root });

    let thrown: unknown;
    try {
      runReadLocalSession({ source, args: {}, env: {} });
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
    const source = new CoworkSource({ sessionsRoot: missing });

    let thrown: unknown;
    try {
      runReadLocalSession({ source, args: {}, env: {} });
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
    makeSession(root, 'account', 'org', 'no-transcript', {
      mtimeMs: 1_000_000,
      noTranscript: true,
    });
    const source = new CoworkSource({ sessionsRoot: root });

    let thrown: unknown;
    try {
      runReadLocalSession({ source, args: {}, env: {} });
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

  test('missing local_* subdirectory → McpError(InvalidParams) because no session is listable', () => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    makeSession(root, 'account', 'org', 'no-local-subdir', {
      mtimeMs: 1_000_000,
      noLocalSubdir: true,
    });
    const source = new CoworkSource({ sessionsRoot: root });

    let thrown: unknown;
    try {
      runReadLocalSession({ source, args: {}, env: {} });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpError);
    const e = thrown as McpError;
    expect(e.code).toBe(ErrorCode.InvalidParams);
    expect(e.message).toContain('no Cowork session found');
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
    makeSession(root, 'account', 'org', 'sess', {
      mtimeMs: 1_000_000,
      transcript: 'x',
      uploads: ['u.txt'],
      outputs: ['o.json'],
    });
    const source = new CoworkSource({ sessionsRoot: root });

    const result = runReadLocalSession({ source, args: {}, env: {} });
    expect(Object.keys(result).sort()).toEqual([
      'account_id',
      'org_id',
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
    makeSession(root, 'account', 'org', 'sess', {
      mtimeMs: 1_000_000,
      transcript: raw,
    });
    const source = new CoworkSource({ sessionsRoot: root });

    const result = runReadLocalSession({ source, args: {}, env: {} });
    expect(result.transcript).toBe(raw);
  });

  test('result is JSON-serializable', () => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    makeSession(root, 'account', 'org', 'sess', {
      mtimeMs: 1_000_000,
      transcript: 'x',
      uploads: ['a.txt'],
      outputs: ['b.json'],
    });
    const source = new CoworkSource({ sessionsRoot: root });
    const result = runReadLocalSession({ source, args: {}, env: {} });
    const roundTripped = JSON.parse(JSON.stringify(result)) as ReadLocalSessionResult;
    expect(roundTripped).toEqual(result);
  });
});

describe('readLocalSessionTool.handler — env is read lazily', () => {
  // Both Claude Code session env vars must be controlled here. When
  // this suite runs INSIDE a Claude Code session, the real
  // CLAUDE_CODE_SESSION_ID would otherwise win over the marker we
  // set via CLAUDE_SESSION_ID, since CLAUDE_CODE_SESSION_ID takes
  // precedence in the resolver.
  const ORIGINAL_CLAUDE_CODE_SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID;
  const ORIGINAL_CLAUDE_SESSION_ID = process.env.CLAUDE_SESSION_ID;
  afterEach(() => {
    if (ORIGINAL_CLAUDE_CODE_SESSION_ID === undefined) {
      delete process.env.CLAUDE_CODE_SESSION_ID;
    } else {
      process.env.CLAUDE_CODE_SESSION_ID = ORIGINAL_CLAUDE_CODE_SESSION_ID;
    }
    if (ORIGINAL_CLAUDE_SESSION_ID === undefined) {
      delete process.env.CLAUDE_SESSION_ID;
    } else {
      process.env.CLAUDE_SESSION_ID = ORIGINAL_CLAUDE_SESSION_ID;
    }
  });

  test('handler reads process.env lazily', async () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_SESSION_ID = 'lazy-marker-id-12345';

    let thrown: unknown;
    try {
      await readLocalSessionTool.handler({});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).message).toContain('lazy-marker-id-12345');
  });

  test('handler reads CLAUDE_CODE_SESSION_ID lazily', async () => {
    // Mirror the lazy-read test but for the canonical env var. This
    // is the path Claude Code actually triggers in production.
    delete process.env.CLAUDE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = 'lazy-marker-code-67890';

    let thrown: unknown;
    try {
      await readLocalSessionTool.handler({});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).message).toContain('lazy-marker-code-67890');
  });
});
