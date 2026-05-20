/**
 * SessionSource abstracts the on-disk layout for transcripts and
 * artifacts so tool handlers don't branch on runtime. The concrete
 * implementation is chosen once at startup by `detectSource()`:
 *
 *   1. `CLAUDE_SESSION_ID` env set → `ClaudeCodeSource`.
 *   2. `COWORK_SESSION_ID` env set → `CoworkSource`.
 *   3. Neither set → pick the source whose newest on-disk session has
 *      the most recent mtime. This handles the common Claude Code case
 *      where the runtime injects `CLAUDE_PROJECT_DIR` but NOT
 *      `CLAUDE_SESSION_ID` into MCP stdio children: we infer the
 *      runtime from the presence of session files instead.
 *   4. Neither source has any on-disk sessions → default to
 *      `ClaudeCodeSource` so the resulting error message references
 *      the Claude Code project dir (the more diagnostic path when the
 *      user is presumably trying to share their current Claude Code
 *      conversation).
 */

import { ClaudeCodeSource } from './claudeCode.js';
import { CoworkSource } from './cowork.js';

/** Summary returned by `listSessions` — one entry per session on disk. */
export type SessionSummary = {
  /** Stable session identifier as the runtime understands it. */
  sessionId: string;
  /** Conversation/thread id when the runtime exposes one (Cowork). */
  conversationId?: string;
  /** Absolute path to the session's on-disk directory. */
  sessionDir: string;
  /** mtime in ms since epoch — used for newest-first ordering. */
  mtimeMs: number;
};

/** Bytes + metadata returned by `readSession`. */
export type SessionPayload = {
  sessionId: string;
  conversationId?: string;
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
  readonly runtime: 'claude-code' | 'cowork';

  /**
   * Resolve the active session per the runtime's rules:
   *   - Cowork: `COWORK_SESSION_ID` env, else newest-by-mtime.
   *   - Claude Code (Phase 2): `CLAUDE_SESSION_ID` env (required).
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
  envOrOptions: NodeJS.ProcessEnv | DetectSourceOptions = {},
): SessionSource {
  const opts = isDetectSourceOptions(envOrOptions)
    ? envOrOptions
    : { env: envOrOptions };
  const env = opts.env ?? process.env;
  const claudeCode = opts.claudeCodeSource ?? new ClaudeCodeSource();
  const cowork = opts.coworkSource ?? new CoworkSource();

  // 1. Explicit env vars win — same as before.
  if (nonBlank(env.CLAUDE_SESSION_ID) !== null) return claudeCode;
  if (nonBlank(env.COWORK_SESSION_ID) !== null) return cowork;

  // 2. Infer from disk: whichever source has more recent files wins.
  // listSessions() returns newest-first, so [0] is the freshest entry.
  const claudeCodeNewest = claudeCode.listSessions()[0]?.mtimeMs ?? 0;
  const coworkNewest = cowork.listSessions()[0]?.mtimeMs ?? 0;
  if (claudeCodeNewest === 0 && coworkNewest === 0) {
    // Neither runtime has any sessions. Default to Claude Code so
    // failure paths point the user at `~/.claude/projects/<cwd>/`
    // rather than the Cowork sessions root — the former is the more
    // useful "we couldn't find anything for your current project"
    // diagnostic. (Cowork users explicitly running outside Cowork
    // are uncommon; Claude Code users with an empty new project are
    // not.)
    return claudeCode;
  }
  return claudeCodeNewest >= coworkNewest ? claudeCode : cowork;
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
  if (v.env !== undefined && typeof v.env !== 'string') return true;
  return false;
}
