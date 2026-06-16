import { test, expect } from 'bun:test';
import { detectSource, type SessionSource, type SessionSummary } from './index.js';

/**
 * Minimal in-memory SessionSource for injection in detectSource tests.
 * Only the fields detectSource consults are populated.
 */
function makeFakeSource(
  runtime: 'claude-code' | 'cowork' | 'codex',
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

test('detectSource: returns ClaudeCodeSource when CLAUDE_CODE_SESSION_ID is set', () => {
  // CLAUDE_CODE_SESSION_ID is the canonical var Claude Code injects
  // into MCP stdio children. Without this branch, detectSource would
  // fall through to the racy mtime heuristic and could pick Cowork
  // when a Cowork transcript was touched more recently.
  expect(
    detectSource({
      env: { CLAUDE_CODE_SESSION_ID: 'sess-abc' },
      claudeCodeSource: makeFakeSource('claude-code', null),
      coworkSource: makeFakeSource('cowork', null),
      codexSource: makeFakeSource('codex', null),
    }).runtime,
  ).toBe('claude-code');
});

test('detectSource: returns ClaudeCodeSource when CLAUDE_SESSION_ID (back-compat alias) is set', () => {
  expect(
    detectSource({
      env: { CLAUDE_SESSION_ID: 'sess-abc' },
      claudeCodeSource: makeFakeSource('claude-code', null),
      coworkSource: makeFakeSource('cowork', null),
      codexSource: makeFakeSource('codex', null),
    }).runtime,
  ).toBe('claude-code');
});

test('detectSource: CLAUDE_CODE_SESSION_ID wins over a fresher Cowork mtime', () => {
  // The bug this guards against: previously CLAUDE_SESSION_ID was the
  // only env-var trigger, and Claude Code doesn't set it. Cowork
  // sessions touched by background tasks could outrank the user's
  // active Claude Code session via the mtime fallback. With the
  // canonical var honored at step 1, env presence beats disk mtime.
  expect(
    detectSource({
      env: { CLAUDE_CODE_SESSION_ID: 'sess-abc' },
      claudeCodeSource: makeFakeSource('claude-code', 1_000),
      coworkSource: makeFakeSource('cowork', 9_000),
      codexSource: makeFakeSource('codex', null),
    }).runtime,
  ).toBe('claude-code');
});

test('detectSource: returns CoworkSource when COWORK_SESSION_ID is set and CLAUDE is not', () => {
  expect(
    detectSource({
      env: { COWORK_SESSION_ID: 'sess-xyz' },
      claudeCodeSource: makeFakeSource('claude-code', null),
      coworkSource: makeFakeSource('cowork', null),
      codexSource: makeFakeSource('codex', null),
    }).runtime,
  ).toBe('cowork');
});

test('detectSource: returns CodexSource when CODEX_THREAD_ID is set and CLAUDE/COWORK are not', () => {
  expect(
    detectSource({
      env: { CODEX_THREAD_ID: 'sess-codex' },
      claudeCodeSource: makeFakeSource('claude-code', null),
      coworkSource: makeFakeSource('cowork', null),
      codexSource: makeFakeSource('codex', null),
    }).runtime,
  ).toBe('codex');
});

test('detectSource: CLAUDE_CODE_SESSION_ID wins over COWORK_SESSION_ID', () => {
  expect(
    detectSource({
      env: { CLAUDE_CODE_SESSION_ID: 'sess-abc', COWORK_SESSION_ID: 'sess-xyz' },
      claudeCodeSource: makeFakeSource('claude-code', null),
      coworkSource: makeFakeSource('cowork', null),
      codexSource: makeFakeSource('codex', null),
    }).runtime,
  ).toBe('claude-code');
});

test('detectSource: Cowork cwd beats CLAUDE_CODE_SESSION_ID (Cowork runs the Claude Code harness)', () => {
  // Regression guard (#995 follow-up): Cowork injects CLAUDE_CODE_SESSION_ID
  // because it *is* the Claude Code harness running in local-agent-mode, but
  // its transcript lives under `local-agent-mode-sessions/`, not
  // `~/.claude/projects`. Detect Cowork by its working directory and route
  // there BEFORE the CLAUDE_CODE_SESSION_ID short-circuit — otherwise the
  // share resolves to ClaudeCodeSource pointed at the wrong root and fails
  // with "session not found" + an empty list_local_sessions.
  expect(
    detectSource({
      env: {
        CLAUDE_CODE_SESSION_ID: 'inner-cc-id',
        CLAUDE_PROJECT_DIR:
          '/Users/q/Library/Application Support/Claude/local-agent-mode-sessions/acct/org/local_abc/wd',
      },
      claudeCodeSource: makeFakeSource('claude-code', null),
      coworkSource: makeFakeSource('cowork', null),
      codexSource: makeFakeSource('codex', null),
    }).runtime,
  ).toBe('cowork');
});

test('detectSource: a normal Claude Code project dir keeps ClaudeCodeSource even though it contains "claude"', () => {
  // The Cowork signal keys off the `local-agent-mode-sessions` path segment
  // specifically, not a substring. A normal repo path must not be mistaken
  // for Cowork.
  expect(
    detectSource({
      env: { CLAUDE_CODE_SESSION_ID: 'sess-abc', CLAUDE_PROJECT_DIR: '/Users/q/repos/lore' },
      claudeCodeSource: makeFakeSource('claude-code', null),
      coworkSource: makeFakeSource('cowork', null),
      codexSource: makeFakeSource('codex', null),
    }).runtime,
  ).toBe('claude-code');
});

test('detectSource: CLAUDE_SESSION_ID (alias) wins over COWORK_SESSION_ID', () => {
  expect(
    detectSource({
      env: { CLAUDE_SESSION_ID: 'sess-abc', COWORK_SESSION_ID: 'sess-xyz' },
      claudeCodeSource: makeFakeSource('claude-code', null),
      coworkSource: makeFakeSource('cowork', null),
      codexSource: makeFakeSource('codex', null),
    }).runtime,
  ).toBe('claude-code');
});

test('detectSource: COWORK_SESSION_ID wins over CODEX_THREAD_ID', () => {
  expect(
    detectSource({
      env: { COWORK_SESSION_ID: 'sess-cowork', CODEX_THREAD_ID: 'sess-codex' },
      claudeCodeSource: makeFakeSource('claude-code', null),
      coworkSource: makeFakeSource('cowork', null),
      codexSource: makeFakeSource('codex', null),
    }).runtime,
  ).toBe('cowork');
});

test('detectSource: ignores blank CLAUDE_CODE_SESSION_ID/CLAUDE_SESSION_ID and falls through to disk heuristic', () => {
  // Empty/whitespace-only env values must NOT be treated as set.
  // With no on-disk sessions for either source, the empty-disk default
  // (ClaudeCodeSource) wins — see the comment in detectSource.
  expect(
    detectSource({
      env: { CLAUDE_CODE_SESSION_ID: '' },
      claudeCodeSource: makeFakeSource('claude-code', null),
      coworkSource: makeFakeSource('cowork', null),
      codexSource: makeFakeSource('codex', null),
    }).runtime,
  ).toBe('claude-code');
  expect(
    detectSource({
      env: { CLAUDE_CODE_SESSION_ID: '   ', CLAUDE_SESSION_ID: '   ' },
      claudeCodeSource: makeFakeSource('claude-code', null),
      coworkSource: makeFakeSource('cowork', null),
      codexSource: makeFakeSource('codex', null),
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
      codexSource: makeFakeSource('codex', 1_000),
    }).runtime,
  ).toBe('cowork');
  expect(
    detectSource({
      env: {},
      claudeCodeSource: makeFakeSource('claude-code', 9_000),
      coworkSource: makeFakeSource('cowork', 5_000),
      codexSource: makeFakeSource('codex', 1_000),
    }).runtime,
  ).toBe('claude-code');
  expect(
    detectSource({
      env: {},
      claudeCodeSource: makeFakeSource('claude-code', 5_000),
      coworkSource: makeFakeSource('cowork', 1_000),
      codexSource: makeFakeSource('codex', 9_000),
    }).runtime,
  ).toBe('codex');
});

test('detectSource: ties still break to Claude Code when Codex is present too', () => {
  expect(
    detectSource({
      env: {},
      claudeCodeSource: makeFakeSource('claude-code', 7_000),
      coworkSource: makeFakeSource('cowork', 7_000),
      codexSource: makeFakeSource('codex', 7_000),
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
      codexSource: makeFakeSource('codex', 1_000),
    }).runtime,
  ).toBe('claude-code');
});

test('detectSource: when only one source has sessions, that source wins', () => {
  expect(
    detectSource({
      env: {},
      claudeCodeSource: makeFakeSource('claude-code', 5_000),
      coworkSource: makeFakeSource('cowork', null),
      codexSource: makeFakeSource('codex', null),
    }).runtime,
  ).toBe('claude-code');
  expect(
    detectSource({
      env: {},
      claudeCodeSource: makeFakeSource('claude-code', null),
      coworkSource: makeFakeSource('cowork', 5_000),
      codexSource: makeFakeSource('codex', null),
    }).runtime,
  ).toBe('cowork');
  expect(
    detectSource({
      env: {},
      claudeCodeSource: makeFakeSource('claude-code', null),
      coworkSource: makeFakeSource('cowork', null),
      codexSource: makeFakeSource('codex', 5_000),
    }).runtime,
  ).toBe('codex');
});

test('detectSource: ignores blank CODEX_THREAD_ID and falls through to disk heuristic', () => {
  expect(
    detectSource({
      env: { CODEX_THREAD_ID: '   ' },
      claudeCodeSource: makeFakeSource('claude-code', null),
      coworkSource: makeFakeSource('cowork', null),
      codexSource: makeFakeSource('codex', 5_000),
    }).runtime,
  ).toBe('codex');
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
      codexSource: makeFakeSource('codex', null),
    }).runtime,
  ).toBe('claude-code');
});

// --- Backwards-compat: bare ProcessEnv argument still works ---

test('detectSource: accepts a bare ProcessEnv (legacy signature)', () => {
  // Existing callers pass `opts.env` directly. This must still resolve
  // by env without hitting real disk.
  expect(detectSource({ CLAUDE_SESSION_ID: 'sess-abc' }).runtime).toBe('claude-code');
  expect(detectSource({ COWORK_SESSION_ID: 'sess-xyz' }).runtime).toBe('cowork');
  expect(detectSource({ CODEX_THREAD_ID: 'sess-codex' }).runtime).toBe('codex');
});

test('detectSource: with no args, reads process.env lazily', () => {
  const originalClaude = process.env.CLAUDE_SESSION_ID;
  const originalCowork = process.env.COWORK_SESSION_ID;
  const originalCodexThread = process.env.CODEX_THREAD_ID;
  const originalCodexSession = process.env.CODEX_SESSION_ID;
  try {
    process.env.CLAUDE_SESSION_ID = 'sess-lazy-env';
    delete process.env.COWORK_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CODEX_SESSION_ID;
    expect(detectSource().runtime).toBe('claude-code');
  } finally {
    if (originalClaude === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = originalClaude;
    if (originalCowork === undefined) delete process.env.COWORK_SESSION_ID;
    else process.env.COWORK_SESSION_ID = originalCowork;
    if (originalCodexThread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = originalCodexThread;
    if (originalCodexSession === undefined) delete process.env.CODEX_SESSION_ID;
    else process.env.CODEX_SESSION_ID = originalCodexSession;
  }
});
