import { test, expect } from "bun:test";
import { detectSource, type SessionSource, type SessionSummary } from "./index.js";

/**
 * Minimal in-memory SessionSource for injection in detectSource tests.
 * Only the fields detectSource consults are populated.
 */
function makeFakeSource(
  runtime: "claude-code" | "cowork" | "codex",
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
    resolveActive: () =>
      sessions[0] ??
      (() => {
        throw new Error("empty fake source");
      })(),
    listSessions: () => sessions,
    findById: (id) => {
      const match = sessions.find((s) => s.sessionId === id);
      if (!match) throw new Error(`session not found: ${id}`);
      return match;
    },
    readSession: () => {
      throw new Error("fake source readSession not implemented");
    },
  };
}

// --- Env-var-based selection (precedence #1 and #2 in detectSource) ---

test("detectSource: CLAUDE_CODE_SESSION_ID wins over a fresher Cowork mtime", () => {
  // The bug this guards against: previously CLAUDE_SESSION_ID was the
  // only env-var trigger, and Claude Code doesn't set it. Cowork
  // sessions touched by background tasks could outrank the user's
  // active Claude Code session via the mtime fallback. With the
  // canonical var honored at step 1, env presence beats disk mtime.
  expect(
    detectSource({
      env: { CLAUDE_CODE_SESSION_ID: "sess-abc" },
      claudeCodeSource: makeFakeSource("claude-code", 1_000),
      coworkSource: makeFakeSource("cowork", 9_000),
      codexSource: makeFakeSource("codex", null),
    }).runtime,
  ).toBe("claude-code");
});

test("detectSource: Cowork cwd beats CLAUDE_CODE_SESSION_ID (Cowork runs the Claude Code harness)", () => {
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
        CLAUDE_CODE_SESSION_ID: "inner-cc-id",
        CLAUDE_PROJECT_DIR:
          "/Users/q/Library/Application Support/Claude/local-agent-mode-sessions/acct/org/local_abc/wd",
      },
      claudeCodeSource: makeFakeSource("claude-code", null),
      coworkSource: makeFakeSource("cowork", null),
      codexSource: makeFakeSource("codex", null),
    }).runtime,
  ).toBe("cowork");
});

test('detectSource: a normal Claude Code project dir keeps ClaudeCodeSource even though it contains "claude"', () => {
  // The Cowork signal keys off the `local-agent-mode-sessions` path segment
  // specifically, not a substring. A normal repo path must not be mistaken
  // for Cowork.
  expect(
    detectSource({
      env: { CLAUDE_CODE_SESSION_ID: "sess-abc", CLAUDE_PROJECT_DIR: "/Users/q/repos/lore" },
      claudeCodeSource: makeFakeSource("claude-code", null),
      coworkSource: makeFakeSource("cowork", null),
      codexSource: makeFakeSource("codex", null),
    }).runtime,
  ).toBe("claude-code");
});

test("detectSource: ignores blank CLAUDE_CODE_SESSION_ID/CLAUDE_SESSION_ID and falls through to disk heuristic", () => {
  // Empty/whitespace-only env values must NOT be treated as set.
  // With no on-disk sessions for either source, the empty-disk default
  // (ClaudeCodeSource) wins — see the comment in detectSource.
  expect(
    detectSource({
      env: { CLAUDE_CODE_SESSION_ID: "" },
      claudeCodeSource: makeFakeSource("claude-code", null),
      coworkSource: makeFakeSource("cowork", null),
      codexSource: makeFakeSource("codex", null),
    }).runtime,
  ).toBe("claude-code");
  expect(
    detectSource({
      env: { CLAUDE_CODE_SESSION_ID: "   ", CLAUDE_SESSION_ID: "   " },
      claudeCodeSource: makeFakeSource("claude-code", null),
      coworkSource: makeFakeSource("cowork", null),
      codexSource: makeFakeSource("codex", null),
    }).runtime,
  ).toBe("claude-code");
});

// --- Disk-mtime fallback (precedence #3) ---

test("detectSource: with no env vars, picks whichever source has newer on-disk sessions", () => {
  expect(
    detectSource({
      env: {},
      claudeCodeSource: makeFakeSource("claude-code", 5_000),
      coworkSource: makeFakeSource("cowork", 9_000),
      codexSource: makeFakeSource("codex", 1_000),
    }).runtime,
  ).toBe("cowork");
  expect(
    detectSource({
      env: {},
      claudeCodeSource: makeFakeSource("claude-code", 9_000),
      coworkSource: makeFakeSource("cowork", 5_000),
      codexSource: makeFakeSource("codex", 1_000),
    }).runtime,
  ).toBe("claude-code");
  expect(
    detectSource({
      env: {},
      claudeCodeSource: makeFakeSource("claude-code", 5_000),
      coworkSource: makeFakeSource("cowork", 1_000),
      codexSource: makeFakeSource("codex", 9_000),
    }).runtime,
  ).toBe("codex");
});

test("detectSource: when only one source has sessions, that source wins", () => {
  expect(
    detectSource({
      env: {},
      claudeCodeSource: makeFakeSource("claude-code", 5_000),
      coworkSource: makeFakeSource("cowork", null),
      codexSource: makeFakeSource("codex", null),
    }).runtime,
  ).toBe("claude-code");
  expect(
    detectSource({
      env: {},
      claudeCodeSource: makeFakeSource("claude-code", null),
      coworkSource: makeFakeSource("cowork", 5_000),
      codexSource: makeFakeSource("codex", null),
    }).runtime,
  ).toBe("cowork");
  expect(
    detectSource({
      env: {},
      claudeCodeSource: makeFakeSource("claude-code", null),
      coworkSource: makeFakeSource("cowork", null),
      codexSource: makeFakeSource("codex", 5_000),
    }).runtime,
  ).toBe("codex");
});

// --- Backwards-compat: bare ProcessEnv argument still works ---

test("detectSource: accepts a bare ProcessEnv (legacy signature)", () => {
  // Existing callers pass `opts.env` directly. This must still resolve
  // by env without hitting real disk.
  expect(detectSource({ CLAUDE_SESSION_ID: "sess-abc" }).runtime).toBe("claude-code");
  expect(detectSource({ COWORK_SESSION_ID: "sess-xyz" }).runtime).toBe("cowork");
  expect(detectSource({ CODEX_THREAD_ID: "sess-codex" }).runtime).toBe("codex");
});

test("detectSource: with no args, reads process.env lazily", () => {
  const originalClaude = process.env.CLAUDE_SESSION_ID;
  const originalCowork = process.env.COWORK_SESSION_ID;
  const originalCodexThread = process.env.CODEX_THREAD_ID;
  const originalCodexSession = process.env.CODEX_SESSION_ID;
  try {
    process.env.CLAUDE_SESSION_ID = "sess-lazy-env";
    delete process.env.COWORK_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CODEX_SESSION_ID;
    expect(detectSource().runtime).toBe("claude-code");
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
