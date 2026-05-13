import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SESSIONS_DIR_NAME,
  defaultSessionsRoot,
  listSessions,
  findLatestSession,
  readSession,
} from './session';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-cowork-session-test-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Create a session directory layout under `<root>/<conv>/<sess>/local_<id>/...`. */
function makeSession(
  root: string,
  conversationId: string,
  sessionId: string,
  opts: {
    localId?: string;
    transcriptName?: 'audit.jsonl' | 'transcript.jsonl' | null;
    transcriptContent?: string;
    uploads?: string[];
    outputs?: string[];
    /** Set mtime on the session directory after creation. */
    mtimeMs?: number;
  } = {},
): string {
  const sessionDir = path.join(root, conversationId, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const localId = opts.localId ?? 'abc123';
  const localDir = path.join(sessionDir, `local_${localId}`);
  fs.mkdirSync(localDir, { recursive: true });
  if (opts.transcriptName !== null) {
    const name = opts.transcriptName ?? 'audit.jsonl';
    fs.writeFileSync(
      path.join(localDir, name),
      opts.transcriptContent ?? '{"hello":"world"}\n',
      'utf8',
    );
  }
  if (opts.uploads) {
    const uploadsDir = path.join(localDir, 'uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    for (const name of opts.uploads) {
      fs.writeFileSync(path.join(uploadsDir, name), 'upload-bytes', 'utf8');
    }
  }
  if (opts.outputs) {
    const outputsDir = path.join(localDir, 'outputs');
    fs.mkdirSync(outputsDir, { recursive: true });
    for (const name of opts.outputs) {
      fs.writeFileSync(path.join(outputsDir, name), 'output-bytes', 'utf8');
    }
  }
  if (opts.mtimeMs !== undefined) {
    const t = opts.mtimeMs / 1000;
    fs.utimesSync(sessionDir, t, t);
  }
  return sessionDir;
}

describe('defaultSessionsRoot', () => {
  test('returns the expected path with a custom home', () => {
    const result = defaultSessionsRoot('/custom/home');
    expect(result).toBe(
      '/custom/home/Library/Application Support/Claude/local-agent-mode-sessions',
    );
  });

  test('uses os.homedir() when no home arg is provided', () => {
    const result = defaultSessionsRoot();
    expect(result).toBe(
      path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'Claude',
        SESSIONS_DIR_NAME,
      ),
    );
  });

  test('SESSIONS_DIR_NAME constant is the expected value', () => {
    expect(SESSIONS_DIR_NAME).toBe('local-agent-mode-sessions');
  });
});

describe('listSessions', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  test('returns [] when root does not exist', () => {
    const missing = path.join(tmp, 'does-not-exist');
    expect(listSessions(missing)).toEqual([]);
  });

  test('returns sessions sorted newest-first by mtime', () => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    makeSession(root, 'convA', 'sess1', { mtimeMs: 1_000_000 });
    makeSession(root, 'convA', 'sess2', { mtimeMs: 3_000_000 });
    makeSession(root, 'convB', 'sess3', { mtimeMs: 2_000_000 });

    const sessions = listSessions(root);
    expect(sessions).toHaveLength(3);
    expect(sessions[0].sessionId).toBe('sess2');
    expect(sessions[1].sessionId).toBe('sess3');
    expect(sessions[2].sessionId).toBe('sess1');
    expect(sessions[0].conversationId).toBe('convA');
    expect(sessions[1].conversationId).toBe('convB');
    expect(sessions[0].sessionDir).toBe(path.join(root, 'convA', 'sess2'));
    expect(sessions[0].mtimeMs).toBeGreaterThan(sessions[1].mtimeMs);
  });

  test('skips conversation entries that are not directories', () => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    makeSession(root, 'convA', 'sess1', { mtimeMs: 1_000_000 });
    // a stray file at the conversation level
    fs.writeFileSync(path.join(root, 'stray.txt'), 'nope', 'utf8');

    const sessions = listSessions(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].conversationId).toBe('convA');
  });

  test('skips session entries that are not directories', () => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    makeSession(root, 'convA', 'sess1', { mtimeMs: 1_000_000 });
    // a stray file at the session level
    fs.writeFileSync(path.join(root, 'convA', 'stray.txt'), 'nope', 'utf8');

    const sessions = listSessions(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe('sess1');
  });

  test('empty root returns []', () => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    expect(listSessions(root)).toEqual([]);
  });
});

describe('findLatestSession', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  test('returns null when root is empty', () => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    expect(findLatestSession(root)).toBeNull();
  });

  test('returns null when root does not exist', () => {
    expect(findLatestSession(path.join(tmp, 'missing'))).toBeNull();
  });

  test('returns the first entry of listSessions (newest-mtime)', () => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    makeSession(root, 'convA', 'old', { mtimeMs: 1_000_000 });
    makeSession(root, 'convA', 'new', { mtimeMs: 5_000_000 });
    makeSession(root, 'convB', 'mid', { mtimeMs: 3_000_000 });

    const latest = findLatestSession(root);
    expect(latest).not.toBeNull();
    expect(latest!.sessionId).toBe('new');
  });
});

describe('readSession', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  test('happy path: reads audit.jsonl, sorted uploads and outputs basenames', () => {
    const sessionDir = makeSession(tmp, 'conv', 'sess', {
      transcriptName: 'audit.jsonl',
      transcriptContent: '{"event":"hi"}\n',
      uploads: ['zeta.txt', 'alpha.png', 'mid.md'],
      outputs: ['out2.json', 'out1.json'],
    });

    const result = readSession(sessionDir);
    expect(result.transcript).toBe('{"event":"hi"}\n');
    expect(result.transcriptPath).toBe(
      path.join(sessionDir, 'local_abc123', 'audit.jsonl'),
    );
    expect(result.uploads).toEqual(['alpha.png', 'mid.md', 'zeta.txt']);
    expect(result.outputs).toEqual(['out1.json', 'out2.json']);
  });

  test('falls back to transcript.jsonl when audit.jsonl is missing', () => {
    const sessionDir = makeSession(tmp, 'conv', 'sess', {
      transcriptName: 'transcript.jsonl',
      transcriptContent: 'fallback-bytes',
    });

    const result = readSession(sessionDir);
    expect(result.transcript).toBe('fallback-bytes');
    expect(result.transcriptPath).toBe(
      path.join(sessionDir, 'local_abc123', 'transcript.jsonl'),
    );
    expect(result.uploads).toEqual([]);
    expect(result.outputs).toEqual([]);
  });

  test('prefers audit.jsonl over transcript.jsonl when both exist', () => {
    const sessionDir = makeSession(tmp, 'conv', 'sess', {
      transcriptName: 'audit.jsonl',
      transcriptContent: 'audit-content',
    });
    // also add transcript.jsonl
    fs.writeFileSync(
      path.join(sessionDir, 'local_abc123', 'transcript.jsonl'),
      'transcript-content',
      'utf8',
    );

    const result = readSession(sessionDir);
    expect(result.transcript).toBe('audit-content');
    expect(result.transcriptPath.endsWith('audit.jsonl')).toBe(true);
  });

  test('throws when local_* subdir is missing', () => {
    const sessionDir = path.join(tmp, 'conv', 'sess-without-local');
    fs.mkdirSync(sessionDir, { recursive: true });
    // add an unrelated file & dir at the session level
    fs.writeFileSync(path.join(sessionDir, 'manifest.json'), '{}', 'utf8');
    fs.mkdirSync(path.join(sessionDir, 'other-dir'));

    expect(() => readSession(sessionDir)).toThrow(
      `Session ${sessionDir} has no local_* subdirectory — is this a Cowork session?`,
    );
  });

  test('throws when no transcript file exists in local_*', () => {
    const sessionDir = makeSession(tmp, 'conv', 'sess', {
      transcriptName: null,
    });
    const localDir = path.join(sessionDir, 'local_abc123');

    expect(() => readSession(sessionDir)).toThrow(
      `Session ${sessionDir} has no transcript file under ${localDir} ` +
        `(looked for audit.jsonl, transcript.jsonl)`,
    );
  });

  test('returns empty uploads/outputs arrays when those subdirs are missing', () => {
    const sessionDir = makeSession(tmp, 'conv', 'sess', {
      transcriptName: 'audit.jsonl',
      transcriptContent: 'x',
    });

    const result = readSession(sessionDir);
    expect(result.uploads).toEqual([]);
    expect(result.outputs).toEqual([]);
  });

  test('filters out hidden files (starting with .) in uploads/outputs', () => {
    const sessionDir = makeSession(tmp, 'conv', 'sess', {
      transcriptName: 'audit.jsonl',
      transcriptContent: 'x',
      uploads: ['visible.txt', '.DS_Store', '.hidden'],
      outputs: ['result.json', '.cache'],
    });

    const result = readSession(sessionDir);
    expect(result.uploads).toEqual(['visible.txt']);
    expect(result.outputs).toEqual(['result.json']);
  });

  test('filters out non-file entries in uploads/outputs', () => {
    const sessionDir = makeSession(tmp, 'conv', 'sess', {
      transcriptName: 'audit.jsonl',
      transcriptContent: 'x',
      uploads: ['real.txt'],
    });
    // create a subdirectory inside uploads — should be skipped
    fs.mkdirSync(path.join(sessionDir, 'local_abc123', 'uploads', 'nested'));

    const result = readSession(sessionDir);
    expect(result.uploads).toEqual(['real.txt']);
  });
});
