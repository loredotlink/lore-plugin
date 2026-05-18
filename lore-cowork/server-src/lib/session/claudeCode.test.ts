import { test, expect } from 'bun:test';
import { ClaudeCodeSource, encodeCwdForClaudeCode } from './claudeCode.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('ClaudeCodeSource reports runtime = "claude-code"', () => {
  const source = new ClaudeCodeSource({ projectsRoot: '/tmp/nonexistent', cwd: '/tmp/x' });
  expect(source.runtime).toBe('claude-code');
});

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-code-source-test-'));
}

function stageProject(root: string, cwd: string): string {
  const dir = path.join(root, encodeCwdForClaudeCode(cwd));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stageSessionFile(projectDir: string, sessionId: string, mtimeMs: number, body = ''): string {
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, body);
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

test('listSessions: returns empty array when project dir does not exist', () => {
  const source = new ClaudeCodeSource({ projectsRoot: '/tmp/definitely-not-here', cwd: '/tmp/x' });
  expect(source.listSessions()).toEqual([]);
});

test('listSessions: enumerates *.jsonl, newest first', () => {
  const root = makeTmpRoot();
  const cwd = '/Users/q/repos/foo';
  const projectDir = stageProject(root, cwd);
  stageSessionFile(projectDir, 'sess-old', 1_000);
  stageSessionFile(projectDir, 'sess-new', 9_000);
  stageSessionFile(projectDir, 'sess-mid', 5_000);

  const source = new ClaudeCodeSource({ projectsRoot: root, cwd });
  const result = source.listSessions();

  expect(result.map((s) => s.sessionId)).toEqual(['sess-new', 'sess-mid', 'sess-old']);
  expect(result[0]?.conversationId).toBeUndefined();
});

test('listSessions: ignores non-jsonl files and subdirectories', () => {
  const root = makeTmpRoot();
  const cwd = '/Users/q/repos/foo';
  const projectDir = stageProject(root, cwd);
  stageSessionFile(projectDir, 'sess-real', 1_000);
  fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'x');
  fs.mkdirSync(path.join(projectDir, 'sess-fake.jsonl'), { recursive: true });

  const source = new ClaudeCodeSource({ projectsRoot: root, cwd });
  expect(source.listSessions().map((s) => s.sessionId)).toEqual(['sess-real']);
});

test('findById: returns the matching session', () => {
  const root = makeTmpRoot();
  const cwd = '/Users/q/repos/foo';
  const projectDir = stageProject(root, cwd);
  stageSessionFile(projectDir, 'sess-target', 1_000);
  stageSessionFile(projectDir, 'sess-other', 2_000);

  const source = new ClaudeCodeSource({ projectsRoot: root, cwd });
  expect(source.findById('sess-target').sessionId).toBe('sess-target');
});

test('findById: throws when no matching .jsonl exists', () => {
  const root = makeTmpRoot();
  const cwd = '/Users/q/repos/foo';
  const projectDir = stageProject(root, cwd);
  stageSessionFile(projectDir, 'sess-real', 1_000);

  const source = new ClaudeCodeSource({ projectsRoot: root, cwd });
  expect(() => source.findById('sess-ghost')).toThrow(/sess-ghost/);
});

test('resolveActive: returns the session named by CLAUDE_SESSION_ID', () => {
  const root = makeTmpRoot();
  const cwd = '/Users/q/repos/foo';
  const projectDir = stageProject(root, cwd);
  stageSessionFile(projectDir, 'sess-target', 1_000);
  stageSessionFile(projectDir, 'sess-other', 9_000);

  const source = new ClaudeCodeSource({ projectsRoot: root, cwd });
  expect(
    source.resolveActive({ CLAUDE_SESSION_ID: 'sess-target' }).sessionId,
  ).toBe('sess-target');
});

test('resolveActive: trims whitespace from CLAUDE_SESSION_ID', () => {
  const root = makeTmpRoot();
  const cwd = '/Users/q/repos/foo';
  const projectDir = stageProject(root, cwd);
  stageSessionFile(projectDir, 'sess-target', 1_000);

  const source = new ClaudeCodeSource({ projectsRoot: root, cwd });
  expect(
    source.resolveActive({ CLAUDE_SESSION_ID: '  sess-target  ' }).sessionId,
  ).toBe('sess-target');
});

test('resolveActive: throws when CLAUDE_SESSION_ID is missing', () => {
  const source = new ClaudeCodeSource({ projectsRoot: '/tmp/anywhere', cwd: '/tmp/x' });
  expect(() => source.resolveActive({})).toThrow(/CLAUDE_SESSION_ID/);
});

test('resolveActive: throws when CLAUDE_SESSION_ID is blank', () => {
  const source = new ClaudeCodeSource({ projectsRoot: '/tmp/anywhere', cwd: '/tmp/x' });
  expect(() => source.resolveActive({ CLAUDE_SESSION_ID: '   ' })).toThrow(/CLAUDE_SESSION_ID/);
});

test('resolveActive: throws when CLAUDE_SESSION_ID names a missing session', () => {
  const root = makeTmpRoot();
  const cwd = '/Users/q/repos/foo';
  const projectDir = stageProject(root, cwd);
  stageSessionFile(projectDir, 'sess-real', 1_000);

  const source = new ClaudeCodeSource({ projectsRoot: root, cwd });
  expect(() =>
    source.resolveActive({ CLAUDE_SESSION_ID: 'sess-ghost' }),
  ).toThrow(/sess-ghost/);
});
