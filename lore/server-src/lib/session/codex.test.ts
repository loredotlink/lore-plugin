import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexSource, defaultCodexSessionsRoot } from './codex.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-test-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function stageCodexSession(
  root: string,
  sessionId: string,
  mtimeMs: number,
  body = 'event-1\nevent-2\n',
): string {
  const dir = path.join(root, '2026', '05', '21');
  fs.mkdirSync(dir, { recursive: true });
  const transcriptPath = path.join(
    dir,
    `rollout-2026-05-21T12-02-10-${sessionId}.jsonl`,
  );
  const firstLine = JSON.stringify({
    timestamp: '2026-05-21T16:03:47.562Z',
    type: 'session_meta',
    payload: { id: sessionId, cwd: '/tmp/example' },
  });
  fs.writeFileSync(transcriptPath, `${firstLine}\n${body}`, 'utf8');
  const t = mtimeMs / 1000;
  fs.utimesSync(transcriptPath, t, t);
  return transcriptPath;
}

test('defaultCodexSessionsRoot: points at ~/.codex/sessions', () => {
  expect(defaultCodexSessionsRoot('/Users/test')).toBe(
    '/Users/test/.codex/sessions',
  );
});

test('listSessions: returns jsonl files newest-first', () => {
  const root = makeTmpDir();
  try {
    stageCodexSession(
      root,
      '019e4b45-dc7c-7de2-a506-85efeaaa7a2d',
      1_000_000,
    );
    stageCodexSession(
      root,
      '019e4b45-dc7c-7de2-a506-85efeaaa7a2e',
      2_000_000,
    );

    const source = new CodexSource({ sessionsRoot: root });
    expect(source.listSessions().map((s) => s.sessionId)).toEqual([
      '019e4b45-dc7c-7de2-a506-85efeaaa7a2e',
      '019e4b45-dc7c-7de2-a506-85efeaaa7a2d',
    ]);
  } finally {
    rmrf(root);
  }
});

test('findById: returns the matching session', () => {
  const root = makeTmpDir();
  try {
    stageCodexSession(
      root,
      '019e4b45-dc7c-7de2-a506-85efeaaa7a2d',
      1_000_000,
    );
    const source = new CodexSource({ sessionsRoot: root });
    expect(
      source.findById('019e4b45-dc7c-7de2-a506-85efeaaa7a2d').sessionId,
    ).toBe('019e4b45-dc7c-7de2-a506-85efeaaa7a2d');
  } finally {
    rmrf(root);
  }
});

test('resolveActive: returns the session named by CODEX_THREAD_ID', () => {
  const root = makeTmpDir();
  try {
    stageCodexSession(
      root,
      '019e4b45-dc7c-7de2-a506-85efeaaa7a2d',
      1_000_000,
    );
    stageCodexSession(
      root,
      '019e4b45-dc7c-7de2-a506-85efeaaa7a2e',
      2_000_000,
    );
    const source = new CodexSource({ sessionsRoot: root });
    expect(
      source.resolveActive({
        CODEX_THREAD_ID: '019e4b45-dc7c-7de2-a506-85efeaaa7a2d',
      }).sessionId,
    ).toBe('019e4b45-dc7c-7de2-a506-85efeaaa7a2d');
  } finally {
    rmrf(root);
  }
});

test('resolveActive: falls back to CODEX_SESSION_ID for backwards compatibility', () => {
  const root = makeTmpDir();
  try {
    stageCodexSession(
      root,
      '019e4b45-dc7c-7de2-a506-85efeaaa7a2d',
      1_000_000,
    );
    const source = new CodexSource({ sessionsRoot: root });
    expect(
      source.resolveActive({
        CODEX_SESSION_ID: '019e4b45-dc7c-7de2-a506-85efeaaa7a2d',
      }).sessionId,
    ).toBe('019e4b45-dc7c-7de2-a506-85efeaaa7a2d');
  } finally {
    rmrf(root);
  }
});

test('resolveActive: returns newest session when env unset', () => {
  const root = makeTmpDir();
  try {
    stageCodexSession(
      root,
      '019e4b45-dc7c-7de2-a506-85efeaaa7a2d',
      1_000_000,
    );
    stageCodexSession(
      root,
      '019e4b45-dc7c-7de2-a506-85efeaaa7a2e',
      2_000_000,
    );
    const source = new CodexSource({ sessionsRoot: root });
    expect(source.resolveActive({}).sessionId).toBe(
      '019e4b45-dc7c-7de2-a506-85efeaaa7a2e',
    );
  } finally {
    rmrf(root);
  }
});

test('resolveActive: throws when no sessions on disk', () => {
  const source = new CodexSource({ sessionsRoot: '/tmp/definitely-empty-codex-root' });
  expect(() => source.resolveActive({})).toThrow(/no Codex session/);
});

test('readSession: returns transcript bytes and empty artifact lists', () => {
  const root = makeTmpDir();
  try {
    const transcriptPath = stageCodexSession(
      root,
      '019e4b45-dc7c-7de2-a506-85efeaaa7a2d',
      1_000_000,
      'event-1\nevent-2\n',
    );
    const source = new CodexSource({ sessionsRoot: root });
    const summary = source.findById('019e4b45-dc7c-7de2-a506-85efeaaa7a2d');
    const payload = source.readSession(summary);
    expect(payload.sessionId).toBe('019e4b45-dc7c-7de2-a506-85efeaaa7a2d');
    expect(payload.transcriptPath).toBe(transcriptPath);
    expect(payload.transcript).toContain('"type":"session_meta"');
    expect(payload.transcript).toContain('event-1');
    expect(payload.uploads).toEqual([]);
    expect(payload.outputs).toEqual([]);
  } finally {
    rmrf(root);
  }
});
