/**
 * SessionSource abstracts the on-disk layout for transcripts and
 * artifacts so tool handlers don't branch on runtime. The concrete
 * implementation is chosen once at startup by `detectSource()`:
 *
 *   0. Working directory has a `local-agent-mode-sessions` path
 *      segment → `CoworkSource`. Checked first because Cowork runs the
 *      Claude Code harness and therefore also injects
 *      `CLAUDE_CODE_SESSION_ID`; without this the next step would route
 *      a Cowork share to `ClaudeCodeSource`, which looks in
 *      `~/.claude/projects` and can't find the Cowork transcript.
 *   1. `CLAUDE_CODE_SESSION_ID` / `CLAUDE_SESSION_ID` env set →
 *      `ClaudeCodeSource`. The canonical var is `CLAUDE_CODE_SESSION_ID`
 *      (Claude Code injects this alongside `CLAUDECODE=1` and
 *      `CLAUDE_PROJECT_DIR`); the bare `CLAUDE_SESSION_ID` is honored
 *      as a back-compat alias.
 *   2. `COWORK_SESSION_ID` env set → `CoworkSource`.
 *   3. `CODEX_THREAD_ID` / `CODEX_SESSION_ID` env set → `CodexSource`.
 *   4. None set → pick the source whose newest on-disk session has
 *      the most recent mtime. This is a defensive fallback for hosts
 *      that don't inject any of the above env vars (rare). The mtime
 *      heuristic is racy when multiple runtimes have recent files —
 *      Claude Code users especially can see the wrong source picked
 *      if a Cowork session was touched more recently — so step 1 is
 *      strongly preferred and step 4 is a last resort.
 *   5. None of the sources has any on-disk sessions → default to
 *      `ClaudeCodeSource` so the resulting error message references
 *      the Claude Code project dir (the more diagnostic path when the
 *      user is presumably trying to share their current Claude Code
 *      conversation).
 */

import path from 'node:path';
import { COWORK_SESSIONS_DIR_NAME } from '@lore/transcript-locate';
import { ClaudeCodeSource } from './claudeCode.js';
import { CodexSource } from './codex.js';
import { CoworkSource } from './cowork.js';

/** Summary returned by `listSessions` — one entry per session on disk. */
export type SessionSummary = {
  /** Stable session identifier as the runtime understands it. */
  sessionId: string;
  /** Cowork account id when the runtime exposes one. */
  accountId?: string;
  /** Cowork organization id when the runtime exposes one. */
  orgId?: string;
  /** Absolute path to the session's on-disk directory. */
  sessionDir: string;
  /** Absolute path to the transcript file when the runtime is file-based. */
  transcriptPath?: string;
  /** mtime in ms since epoch — used for newest-first ordering. */
  mtimeMs: number;
};

/** Bytes + metadata returned by `readSession`. */
export type SessionPayload = {
  sessionId: string;
  accountId?: string;
  orgId?: string;
  /** Absolute path to the transcript file. */
  transcriptPath: string;
  /** Raw bytes of the transcript file as a UTF-8 string. */
  transcript: string;
  /** Basenames found under the session's uploads directory. */
  uploads: string[];
  /** Basenames found under the session's outputs directory. */
  outputs: string[];
};

export interface SessionSource {
  /** Human label used in error messages. */
  readonly runtime: 'claude-code' | 'cowork' | 'codex';

  /**
   * Resolve the active session per the runtime's rules:
   *   - Cowork: `COWORK_SESSION_ID` env, else newest-by-mtime.
   *   - Claude Code: `CLAUDE_CODE_SESSION_ID` (canonical) or
   *     `CLAUDE_SESSION_ID` (back-compat alias), else newest-by-mtime.
   *   - Codex: `CODEX_THREAD_ID` / `CODEX_SESSION_ID` env, else
   *     newest-by-mtime.
   * Returns the resolved `SessionSummary`. Throws a plain `Error` with
   * an actionable message if no session can be resolved.
   */
  resolveActive(env: NodeJS.ProcessEnv): SessionSummary;

  /** Enumerate every session on disk, newest first. */
  listSessions(): SessionSummary[];

  /**
   * Look up a session by id. Throws a plain `Error` if no match exists.
   * `sessionId` must already be trimmed by the caller.
   */
  findById(sessionId: string): SessionSummary;

  /** Read transcript bytes + artifact filenames for the given session. */
  readSession(session: SessionSummary): SessionPayload;
}

/**
 * Returns the trimmed value when it's a non-empty string, else `null`.
 * Shared by every `SessionSource` and by `detectSource` for env-var checks.
 */
export function nonBlank(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Optional injection hooks for `detectSource`. Real callers pass
 * nothing (or just an `env` map); tests can inject pre-configured
 * sources so they don't have to monkey-patch `os.homedir()`.
 */
export type DetectSourceOptions = {
  /** Override `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Inject a Claude Code source (typically with a tmpdir root). */
  claudeCodeSource?: SessionSource;
  /** Inject a Cowork source (typically with a tmpdir root). */
  coworkSource?: SessionSource;
  /** Inject a Codex source (typically with a tmpdir root). */
  codexSource?: SessionSource;
};

/**
 * Choose the right SessionSource for the current runtime. See the
 * file-level comment for the resolution order.
 *
 * Accepts either a bare `ProcessEnv` (legacy callers) or an options
 * bag with injection hooks (tests). The argument is destructured by
 * shape: a plain process env has no `claudeCodeSource`/`coworkSource`
 * field, so the heuristic is robust.
 */
export function detectSource(
  envOrOptions?: NodeJS.ProcessEnv | DetectSourceOptions,
): SessionSource {
  const opts =
    envOrOptions === undefined
      ? {}
      : isDetectSourceOptions(envOrOptions)
        ? envOrOptions
        : { env: envOrOptions };
  const env = opts.env ?? process.env;
  const claudeCode = opts.claudeCodeSource ?? new ClaudeCodeSource();
  const cowork = opts.coworkSource ?? new CoworkSource();
  const codex = opts.codexSource ?? new CodexSource();

  // 0. Cowork runtime signal — checked BEFORE the Claude Code env vars.
  //    Cowork *is* the Claude Code harness running in local-agent-mode, so
  //    it injects `CLAUDE_CODE_SESSION_ID` too. But a Cowork transcript lives
  //    under `local-agent-mode-sessions/<acct>/<org>/local_*/audit.jsonl`, not
  //    in `~/.claude/projects`, so routing to ClaudeCodeSource (step 1) would
  //    look in the wrong root and fail with "session not found" + an empty
  //    list_local_sessions. Detect Cowork the same way the CLI's
  //    `resolveSessionFromCwd` does: the working directory has a
  //    `local-agent-mode-sessions` path segment. Prefer `CLAUDE_PROJECT_DIR`
  //    (Claude Code injects it into MCP stdio children) over `process.cwd()`.
  if (isCoworkCwd(nonBlank(env.CLAUDE_PROJECT_DIR) ?? safeCwd())) {
    return cowork;
  }

  // 1. Explicit env vars win — same as before. Both Claude Code
  //    session var names are honored; `CLAUDE_CODE_SESSION_ID` is
  //    the canonical one (matches the `CLAUDECODE=1` namespace),
  //    `CLAUDE_SESSION_ID` is a back-compat alias.
  if (nonBlank(env.CLAUDE_CODE_SESSION_ID) !== null) return claudeCode;
  if (nonBlank(env.CLAUDE_SESSION_ID) !== null) return claudeCode;
  if (nonBlank(env.COWORK_SESSION_ID) !== null) return cowork;
  if (nonBlank(env.CODEX_THREAD_ID) !== null) return codex;
  if (nonBlank(env.CODEX_SESSION_ID) !== null) return codex;

  // 2. Infer from disk: whichever source has more recent files wins.
  // listSessions() returns newest-first, so [0] is the freshest entry.
  const claudeCodeNewest = claudeCode.listSessions()[0]?.mtimeMs ?? 0;
  const coworkNewest = cowork.listSessions()[0]?.mtimeMs ?? 0;
  const codexNewest = codex.listSessions()[0]?.mtimeMs ?? 0;
  if (claudeCodeNewest === 0 && coworkNewest === 0 && codexNewest === 0) {
    // Neither runtime has any sessions. Default to Claude Code so
    // failure paths point the user at `~/.claude/projects/<cwd>/`
    // rather than the Cowork sessions root — the former is the more
    // useful "we couldn't find anything for your current project"
    // diagnostic. (Cowork users explicitly running outside Cowork
    // are uncommon; Claude Code users with an empty new project are
    // not.)
    return claudeCode;
  }
  if (claudeCodeNewest >= coworkNewest && claudeCodeNewest >= codexNewest) {
    return claudeCode;
  }
  return coworkNewest >= codexNewest ? cowork : codex;
}

/**
 * True when `cwd` lives under a Cowork sessions root — i.e. has a
 * `local-agent-mode-sessions` path segment. Matches the segment exactly
 * (not a substring) so a normal repo path that merely contains the words
 * isn't misdetected. Returns false for null/blank input.
 */
function isCoworkCwd(cwd: string | null): boolean {
  if (cwd === null) return false;
  return path.resolve(cwd).split(path.sep).includes(COWORK_SESSIONS_DIR_NAME);
}

/** `process.cwd()` guarded against a deleted working directory. */
function safeCwd(): string | null {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

function isDetectSourceOptions(
  value: NodeJS.ProcessEnv | DetectSourceOptions,
): value is DetectSourceOptions {
  if (typeof value !== 'object' || value === null) return false;
  // ProcessEnv has only string values; DetectSourceOptions has
  // structured object values for `env`/`claudeCodeSource`/
  // `coworkSource`. Any of those three keys present with a non-string
  // value is an unambiguous signal it's the options bag.
  const v = value as Record<string, unknown>;
  if (v.claudeCodeSource !== undefined && typeof v.claudeCodeSource !== 'string') {
    return true;
  }
  if (v.coworkSource !== undefined && typeof v.coworkSource !== 'string') {
    return true;
  }
  if (v.codexSource !== undefined && typeof v.codexSource !== 'string') {
    return true;
  }
  if (v.env !== undefined && typeof v.env !== 'string') return true;
  return false;
}
