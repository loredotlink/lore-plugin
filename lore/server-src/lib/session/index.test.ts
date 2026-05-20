import { test, expect } from 'bun:test';
import { detectSource, type SessionSource, type SessionSummary } from './index.js';

/**
 * Minimal in-memory SessionSource for injection in detectSource tests.
 * Only the fields detectSource consults are populated.
 */
function makeFakeSource(
  runtime: 'claude-code' | 'cowork',
  newestMtimeMs: number | null,
): SessionSource {
  const sessions: SessionSummary[] =
    newestMtimeMs === null
      ? []
      : [
          {
            sessionId: `fake-${runtime}-newest`,
            sessionDir: `/tmp/fake-${runtime}`,
            mtimeMs: newestMtimeMs,
          },
        ];
  return {
    runtime,
    resolveActive: () => sessions[0] ?? (() => { throw new Error('empty fake source'); })(),
    listSessions: () => sessions,
    findById: (id) => {
      const match = sessions.find((s) => s.sessionId === id);
      if (!match) throw new Error(`session not found: ${id}`);
      return match;
    },
    readSession: () => { throw new Error('fake source readSession not implemented'); },
  };
}

// --- Env-var-based selection (precedence #1 and #2 in detectSource) ---

test('detectSource: returns ClaudeCodeSource when CLAUDE_SESSION_ID is set', () => {
  expect(
    detectSource({
      env: { CLAUDE_SESSION_ID: 'sess-abc' },
      claudeCodeSource: makeFakeSource('claude-code', null),
      coworkSource: makeFakeSource('cowork', null),
    }).runtime,
  ).toBe('claude-code');
});

test('detectSource: returns CoworkSource when COWORK_SESSION_ID is set and CLAUDE is not', () => {
  expect(
    detectSource({
      env: { COWORK_SESSION_ID: 'sess-xyz' },
      claudeCodeSource: makeFakeSource('claude-code', null),
      coworkSource: makeFakeSource('cowork', null),
    }).runtime,
  ).toBe('cowork');
});

test('detectSource: CLAUDE_SESSION_ID wins over COWORK_SESSION_ID', () => {
  expect(
    detectSource({
      env: { CLAUDE_SESSION_ID: 'sess-abc', COWORK_SESSION_ID: 'sess-xyz' },
      claudeCodeSource: makeFakeSource('claude-code', null),
      coworkSource: makeFakeSource('cowork', null),
    }).runtime,
  ).toBe('claude-code');
});

test('detectSource: ignores blank CLAUDE_SESSION_ID and falls through to disk heuristic', () => {
  // Empty/whitespace-only env value must NOT be treated as set.
  // With no on-disk sessions for either source, the empty-disk default
  // (ClaudeCodeSource) wins — see the comment in detectSource.
  expect(
    detectSource({
      env: { CLAUDE_SESSION_ID: '' },
      claudeCodeSource: makeFakeSource('claude-code', null),
      coworkSource: makeFakeSource('cowork', null),
    }).runtime,
  ).toBe('claude-code');
  expect(
    detectSource({
      env: { CLAUDE_SESSION_ID: '   ' },
      claudeCodeSource: makeFakeSource('claude-code', null),
      coworkSource: makeFakeSource('cowork', null),
    }).runtime,
  ).toBe('claude-code');
});

// --- Disk-mtime fallback (precedence #3) ---

test('detectSource: with no env vars, picks whichever source has newer on-disk sessions', () => {
  expect(
    detectSource({
      env: {},
      claudeCodeSource: makeFakeSource('claude-code', 5_000),
      coworkSource: makeFakeSource('cowork', 9_000),
    }).runtime,
  ).toBe('cowork');
  expect(
    detectSource({
      env: {},
      claudeCodeSource: makeFakeSource('claude-code', 9_000),
      coworkSource: makeFakeSource('cowork', 5_000),
    }).runtime,
  ).toBe('claude-code');
});

test('detectSource: ties break to Claude Code (newest-first scan order)', () => {
  // Equal mtimes is rare in practice but the tie-breaker matters: we
  // prefer the runtime that's typically more "current" in a Claude
  // Code session, since CLAUDE_PROJECT_DIR is the common signal that
  // led the user to invoke /lore:share.
  expect(
    detectSource({
      env: {},
      claudeCodeSource: makeFakeSource('claude-code', 7_000),
      coworkSource: makeFakeSource('cowork', 7_000),
    }).runtime,
  ).toBe('claude-code');
});

test('detectSource: when only one source has sessions, that source wins', () => {
  expect(
    detectSource({
      env: {},
      claudeCodeSource: makeFakeSource('claude-code', 5_000),
      coworkSource: makeFakeSource('cowork', null),
    }).runtime,
  ).toBe('claude-code');
  expect(
    detectSource({
      env: {},
      claudeCodeSource: makeFakeSource('claude-code', null),
      coworkSource: makeFakeSource('cowork', 5_000),
    }).runtime,
  ).toBe('cowork');
});

test('detectSource: when neither source has sessions, defaults to ClaudeCodeSource', () => {
  // Diagnostic preference: error messages from ClaudeCodeSource
  // reference the encoded-cwd project dir, which is more useful than
  // the generic Cowork sessions root.
  expect(
    detectSource({
      env: {},
      claudeCodeSource: makeFakeSource('claude-code', null),
      coworkSource: makeFakeSource('cowork', null),
    }).runtime,
  ).toBe('claude-code');
});

// --- Backwards-compat: bare ProcessEnv argument still works ---

test('detectSource: accepts a bare ProcessEnv (legacy signature)', () => {
  // Existing callers pass `opts.env` directly. This must still resolve
  // by env without hitting real disk.
  expect(detectSource({ CLAUDE_SESSION_ID: 'sess-abc' }).runtime).toBe('claude-code');
  expect(detectSource({ COWORK_SESSION_ID: 'sess-xyz' }).runtime).toBe('cowork');
});
