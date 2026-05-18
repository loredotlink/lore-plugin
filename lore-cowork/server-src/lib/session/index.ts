/**
 * SessionSource abstracts the on-disk layout for transcripts and
 * artifacts so tool handlers don't branch on runtime. The concrete
 * implementation is chosen once at startup by `detectSource()`.
 *
 * Phase 1 ships a single implementation (`CoworkSource`); Phase 2
 * adds `ClaudeCodeSource` and teaches the factory to choose between
 * them.
 */

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

import { ClaudeCodeSource } from './claudeCode.js';
import { CoworkSource } from './cowork.js';

/**
 * Choose the right SessionSource for the current runtime.
 * Returns `ClaudeCodeSource` when `CLAUDE_SESSION_ID` is set,
 * otherwise falls back to `CoworkSource`.
 */
export function detectSource(env: NodeJS.ProcessEnv = process.env): SessionSource {
  if (nonBlank(env.CLAUDE_SESSION_ID) !== null) return new ClaudeCodeSource();
  return new CoworkSource();
}
