import { test, expect } from 'bun:test';
import { ClaudeCodeSource, encodeCwdForClaudeCode } from './claudeCode.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('ClaudeCodeSource reports runtime = "claude-code"', () => {
  const source = new ClaudeCodeSource({ projectsRoot: '/tmp/nonexistent', cwd: '/tmp/x' });
  expect(source.runtime).toBe('claude-code');
});

// Lock in the encoding rules against what Claude Code actually writes
// to `~/.claude/projects/`. Verified empirically — any character outside
// [A-Za-z0-9_-] collapses to a single dash, and consecutive specials
// each produce their own dash (so `/.claude/` becomes `--claude-`).
//
// Regression: before May 2026 the encoder only replaced `/`, leaving
// dots in the encoded path. That meant the plugin's ClaudeCodeSource
// looked for sessions in a directory that didn't exist on disk for
// any `.claude/...` path (e.g. `.claude/worktrees/...`), silently
// returning an empty list and falling through to Cowork.
test('encodeCwdForClaudeCode: replaces "/" with "-"', () => {
  expect(encodeCwdForClaudeCode('/Users/q/repos/foo')).toBe('-Users-q-repos-foo');
});

test('encodeCwdForClaudeCode: replaces "." with "-" too (matches Claude Code)', () => {
  // `/.config/` → `--config-` (two dashes: one for `/`, one for `.`).
  expect(encodeCwdForClaudeCode('/Users/q/.config/amp')).toBe('-Users-q--config-amp');
  // `/repos/lore/.claude/worktrees/foo` is the case the original bug
  // surfaced under (worktree paths under `.claude/`).
  expect(
    encodeCwdForClaudeCode('/Users/q/repos/lore/.claude/worktrees/foo'),
  ).toBe('-Users-q-repos-lore--claude-worktrees-foo');
});

test('encodeCwdForClaudeCode: preserves underscores and existing dashes', () => {
  expect(encodeCwdForClaudeCode('/Users/q/my_repo-name/sub')).toBe('-Users-q-my_repo-name-sub');
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

// Claude Code does NOT inject CLAUDE_SESSION_ID into MCP stdio
// children as of May 2026. The fallback to newest-by-mtime is the
// common path in practice, so these tests pin both halves of the
// behavior: env id wins when set, newest jsonl wins otherwise.
test('resolveActive: falls back to newest-mtime jsonl when CLAUDE_SESSION_ID is missing', () => {
  const root = makeTmpRoot();
  const cwd = '/Users/q/repos/foo';
  const projectDir = stageProject(root, cwd);
  stageSessionFile(projectDir, 'sess-old', 1_000);
  stageSessionFile(projectDir, 'sess-new', 9_000);
  stageSessionFile(projectDir, 'sess-mid', 5_000);

  const source = new ClaudeCodeSource({ projectsRoot: root, cwd });
  expect(source.resolveActive({}).sessionId).toBe('sess-new');
});

test('resolveActive: falls back to newest-mtime jsonl when CLAUDE_SESSION_ID is blank', () => {
  const root = makeTmpRoot();
  const cwd = '/Users/q/repos/foo';
  const projectDir = stageProject(root, cwd);
  stageSessionFile(projectDir, 'sess-only', 1_000);

  const source = new ClaudeCodeSource({ projectsRoot: root, cwd });
  expect(source.resolveActive({ CLAUDE_SESSION_ID: '   ' }).sessionId).toBe('sess-only');
});

test('resolveActive: throws with project-dir-mentioning error when no jsonls exist', () => {
  // No staged project dir at all — the "newest mtime" fallback finds
  // nothing and must surface a diagnostic pointing the user at the
  // path the plugin was looking in.
  const source = new ClaudeCodeSource({
    projectsRoot: '/tmp/definitely-does-not-exist',
    cwd: '/Users/q/repos/foo',
  });
  expect(() => source.resolveActive({})).toThrow(/-Users-q-repos-foo/);
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

test('constructor: uses CLAUDE_PROJECT_DIR env var when opts.cwd is not provided', () => {
  // Claude Code injects CLAUDE_PROJECT_DIR but not CLAUDE_SESSION_ID,
  // so the source must use that env var to find the right project
  // directory rather than process.cwd() (which may be different).
  const root = makeTmpRoot();
  const cwd = '/Users/q/repos/from-env-var';
  const projectDir = stageProject(root, cwd);
  stageSessionFile(projectDir, 'sess-via-env', 1_000);

  const originalEnv = process.env.CLAUDE_PROJECT_DIR;
  try {
    process.env.CLAUDE_PROJECT_DIR = cwd;
    const source = new ClaudeCodeSource({ projectsRoot: root });
    // resolveActive falls back to newest-by-mtime in the dir derived
    // from CLAUDE_PROJECT_DIR — proving the env var was honored.
    expect(source.resolveActive({}).sessionId).toBe('sess-via-env');
  } finally {
    if (originalEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalEnv;
  }
});

test('constructor: opts.cwd takes precedence over CLAUDE_PROJECT_DIR', () => {
  const root = makeTmpRoot();
  const explicitCwd = '/Users/q/repos/explicit';
  const explicitDir = stageProject(root, explicitCwd);
  stageSessionFile(explicitDir, 'sess-from-opts', 1_000);
  // Stage a second project dir keyed by a DIFFERENT cwd that the env
  // var points at — to prove the opts override won.
  const envCwd = '/Users/q/repos/env';
  const envDir = stageProject(root, envCwd);
  stageSessionFile(envDir, 'sess-from-env', 9_000);

  const originalEnv = process.env.CLAUDE_PROJECT_DIR;
  try {
    process.env.CLAUDE_PROJECT_DIR = envCwd;
    const source = new ClaudeCodeSource({ projectsRoot: root, cwd: explicitCwd });
    expect(source.resolveActive({}).sessionId).toBe('sess-from-opts');
  } finally {
    if (originalEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = originalEnv;
  }
});

test('readSession: returns transcript bytes and empty artifact arrays', () => {
  const root = makeTmpRoot();
  const cwd = '/Users/q/repos/foo';
  const projectDir = stageProject(root, cwd);
  stageSessionFile(projectDir, 'sess-A', 1_000, '{"type":"user"}\n{"type":"assistant"}\n');

  const source = new ClaudeCodeSource({ projectsRoot: root, cwd });
  const summary = source.findById('sess-A');
  const payload = source.readSession(summary);

  expect(payload.transcript).toBe('{"type":"user"}\n{"type":"assistant"}\n');
  expect(payload.uploads).toEqual([]);
  expect(payload.outputs).toEqual([]);
  expect(payload.sessionId).toBe('sess-A');
  expect(payload.transcriptPath).toBe(path.join(projectDir, 'sess-A.jsonl'));
});

test('readSession: throws when the .jsonl file disappeared between resolve and read', () => {
  const root = makeTmpRoot();
  const cwd = '/Users/q/repos/foo';
  const projectDir = stageProject(root, cwd);
  stageSessionFile(projectDir, 'sess-A', 1_000, 'x\n');

  const source = new ClaudeCodeSource({ projectsRoot: root, cwd });
  const summary = source.findById('sess-A');
  fs.rmSync(path.join(projectDir, 'sess-A.jsonl'));

  expect(() => source.readSession(summary)).toThrow(/transcript file/);
});
