import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoworkSource } from './cowork.js';
import type { SessionSummary } from './index.js';

test('CoworkSource reports runtime = "cowork"', () => {
  const source = new CoworkSource({ sessionsRoot: '/tmp/nonexistent' });
  expect(source.runtime).toBe('cowork');
});

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-source-test-'));
}

function stageSession(root: string, convId: string, sessId: string, mtimeMs: number): string {
  const sessionDir = path.join(root, convId, sessId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.utimesSync(sessionDir, new Date(mtimeMs), new Date(mtimeMs));
  return sessionDir;
}

test('listSessions: returns empty array when root does not exist', () => {
  const source = new CoworkSource({ sessionsRoot: '/tmp/definitely-not-here-xyz' });
  expect(source.listSessions()).toEqual([]);
});

test('listSessions: enumerates conv/sess pairs, newest first', () => {
  const root = makeTmpRoot();
  stageSession(root, 'conv-A', 'sess-1', 1_000);
  stageSession(root, 'conv-A', 'sess-2', 3_000);
  stageSession(root, 'conv-B', 'sess-3', 2_000);

  const source = new CoworkSource({ sessionsRoot: root });
  const result = source.listSessions();

  expect(result.map((s) => s.sessionId)).toEqual(['sess-2', 'sess-3', 'sess-1']);
  expect(result[0]?.conversationId).toBe('conv-A');
  expect(result[1]?.conversationId).toBe('conv-B');
});

test('findById: returns the matching session', () => {
  const root = makeTmpRoot();
  stageSession(root, 'conv-A', 'sess-target', 1_000);
  stageSession(root, 'conv-A', 'sess-other', 2_000);

  const source = new CoworkSource({ sessionsRoot: root });
  const found = source.findById('sess-target');

  expect(found.sessionId).toBe('sess-target');
  expect(found.conversationId).toBe('conv-A');
});

test('findById: throws when session does not exist', () => {
  const root = makeTmpRoot();
  stageSession(root, 'conv-A', 'sess-real', 1_000);

  const source = new CoworkSource({ sessionsRoot: root });
  expect(() => source.findById('sess-ghost')).toThrow(/sess-ghost/);
});

test('resolveActive: returns newest session when env unset', () => {
  const root = makeTmpRoot();
  stageSession(root, 'conv-A', 'sess-old', 1_000);
  stageSession(root, 'conv-A', 'sess-new', 9_000);

  const source = new CoworkSource({ sessionsRoot: root });
  expect(source.resolveActive({}).sessionId).toBe('sess-new');
});

test('resolveActive: COWORK_SESSION_ID env wins over newest-by-mtime', () => {
  const root = makeTmpRoot();
  stageSession(root, 'conv-A', 'sess-targeted', 1_000);
  stageSession(root, 'conv-A', 'sess-newer', 9_000);

  const source = new CoworkSource({ sessionsRoot: root });
  expect(
    source.resolveActive({ COWORK_SESSION_ID: 'sess-targeted' }).sessionId,
  ).toBe('sess-targeted');
});

test('resolveActive: trims whitespace from COWORK_SESSION_ID', () => {
  const root = makeTmpRoot();
  stageSession(root, 'conv-A', 'sess-target', 1_000);

  const source = new CoworkSource({ sessionsRoot: root });
  expect(
    source.resolveActive({ COWORK_SESSION_ID: '  sess-target  ' }).sessionId,
  ).toBe('sess-target');
});

test('resolveActive: blank COWORK_SESSION_ID is ignored', () => {
  const root = makeTmpRoot();
  stageSession(root, 'conv-A', 'sess-newest', 9_000);

  const source = new CoworkSource({ sessionsRoot: root });
  expect(
    source.resolveActive({ COWORK_SESSION_ID: '   ' }).sessionId,
  ).toBe('sess-newest');
});

test('resolveActive: throws when no sessions on disk', () => {
  const source = new CoworkSource({ sessionsRoot: '/tmp/definitely-empty-xyz' });
  expect(() => source.resolveActive({})).toThrow(/no Cowork session/);
});

test('resolveActive: throws when COWORK_SESSION_ID names a missing session', () => {
  const root = makeTmpRoot();
  stageSession(root, 'conv-A', 'sess-real', 1_000);

  const source = new CoworkSource({ sessionsRoot: root });
  expect(() =>
    source.resolveActive({ COWORK_SESSION_ID: 'sess-ghost' }),
  ).toThrow(/sess-ghost/);
});

function stageFullSession(
  root: string,
  convId: string,
  sessId: string,
  opts: {
    transcript?: string;
    transcriptName?: 'audit.jsonl' | 'transcript.jsonl';
    uploads?: string[];
    outputs?: string[];
    localSubdir?: string;
  } = {},
): SessionSummary {
  const sessionDir = path.join(root, convId, sessId);
  const localDir = path.join(sessionDir, opts.localSubdir ?? 'local_abc');
  fs.mkdirSync(localDir, { recursive: true });
  if (opts.transcript !== undefined) {
    fs.writeFileSync(
      path.join(localDir, opts.transcriptName ?? 'audit.jsonl'),
      opts.transcript,
    );
  }
  for (const name of opts.uploads ?? []) {
    fs.mkdirSync(path.join(localDir, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(localDir, 'uploads', name), 'x');
  }
  for (const name of opts.outputs ?? []) {
    fs.mkdirSync(path.join(localDir, 'outputs'), { recursive: true });
    fs.writeFileSync(path.join(localDir, 'outputs', name), 'x');
  }
  const stat = fs.statSync(sessionDir);
  return {
    sessionId: sessId,
    conversationId: convId,
    sessionDir,
    mtimeMs: stat.mtimeMs,
  };
}

test('readSession: returns transcript bytes and artifact filenames', () => {
  const root = makeTmpRoot();
  const summary = stageFullSession(root, 'conv-A', 'sess-A', {
    transcript: '{"role":"user"}\n',
    uploads: ['a.txt', 'b.png'],
    outputs: ['out.json'],
  });

  const source = new CoworkSource({ sessionsRoot: root });
  const payload = source.readSession(summary);

  expect(payload.transcript).toBe('{"role":"user"}\n');
  expect(payload.uploads).toEqual(['a.txt', 'b.png']);
  expect(payload.outputs).toEqual(['out.json']);
  expect(payload.sessionId).toBe('sess-A');
});

test('readSession: accepts transcript.jsonl as a fallback filename', () => {
  const root = makeTmpRoot();
  const summary = stageFullSession(root, 'conv-A', 'sess-A', {
    transcript: 'fallback\n',
    transcriptName: 'transcript.jsonl',
  });

  const source = new CoworkSource({ sessionsRoot: root });
  expect(source.readSession(summary).transcript).toBe('fallback\n');
});

test('readSession: throws when session has no local_* subdirectory', () => {
  const root = makeTmpRoot();
  const sessionDir = path.join(root, 'conv-A', 'sess-A');
  fs.mkdirSync(sessionDir, { recursive: true });
  const summary: SessionSummary = {
    sessionId: 'sess-A',
    conversationId: 'conv-A',
    sessionDir,
    mtimeMs: fs.statSync(sessionDir).mtimeMs,
  };

  const source = new CoworkSource({ sessionsRoot: root });
  expect(() => source.readSession(summary)).toThrow(/local_\* subdirectory/);
});

test('readSession: throws when local_* subdir has no transcript', () => {
  const root = makeTmpRoot();
  const summary = stageFullSession(root, 'conv-A', 'sess-A', {});

  const source = new CoworkSource({ sessionsRoot: root });
  expect(() => source.readSession(summary)).toThrow(/transcript file/);
});

test('readSession: picks the local_* subdir with newest transcript mtime', () => {
  const root = makeTmpRoot();
  const sessionDir = path.join(root, 'conv-A', 'sess-A');
  fs.mkdirSync(path.join(sessionDir, 'local_old'), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, 'local_new'), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'local_old', 'audit.jsonl'), 'OLD\n');
  fs.writeFileSync(path.join(sessionDir, 'local_new', 'audit.jsonl'), 'NEW\n');
  fs.utimesSync(
    path.join(sessionDir, 'local_old', 'audit.jsonl'),
    new Date(1_000),
    new Date(1_000),
  );
  fs.utimesSync(
    path.join(sessionDir, 'local_new', 'audit.jsonl'),
    new Date(9_000),
    new Date(9_000),
  );

  const summary: SessionSummary = {
    sessionId: 'sess-A',
    conversationId: 'conv-A',
    sessionDir,
    mtimeMs: fs.statSync(sessionDir).mtimeMs,
  };
  const source = new CoworkSource({ sessionsRoot: root });
  expect(source.readSession(summary).transcript).toBe('NEW\n');
});
