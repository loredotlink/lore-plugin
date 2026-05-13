/**
 * MCP tool: `list_local_sessions`.
 *
 * Enumerates every Cowork session under the default sessions root,
 * sorted newest-first by directory mtime. Returns an empty array when
 * the root doesn't exist — matches the underlying `listSessions` lib
 * behavior so the agent can browse a fresh machine without seeing a
 * tool error.
 *
 * Why this exists separately from the default share flow:
 *   - The default share flow uses `find_latest_session` / the CLI's
 *     own resolution to pick "this" session. It does not call this
 *     tool.
 *   - This tool is the agent's escape hatch when the user asks to
 *     share something other than the current session (e.g. "share the
 *     one from yesterday"). The agent lists, picks by mtime ordering,
 *     and reads the chosen session explicitly.
 *
 * Contract:
 *   - No arguments. Input schema is the empty object with
 *     `additionalProperties: false` so the SDK rejects callers that
 *     try to narrow the listing — this keeps the tool surface trivial
 *     to reason about.
 *   - Return is a plain JSON-serializable object: every field maps to
 *     a number or snake_case string. No Date instances.
 *
 * Testability:
 *   The pure `runListLocalSessions(root)` is exported separately so
 *   unit tests can exercise the mapping + ordering against tmpdir
 *   fixtures without monkey-patching `os.homedir()`. The exported
 *   `listLocalSessionsTool.handler` is the production wiring that
 *   calls `defaultSessionsRoot()` — it cannot be redirected, matching
 *   the "no env vars or arguments" constraint.
 */
import { defaultSessionsRoot, listSessions } from '../lib/session.js';
import type { ToolDefinition } from '../lib/tool.js';

export type ListLocalSessionsResult = {
  sessions: Array<{
    session_id: string;
    conversation_id: string;
    mtime_ms: number;
  }>;
};

/**
 * Pure core: given a sessions root, return the mapped, newest-first
 * listing. Used by the tool handler and exercised directly by tests.
 */
export function runListLocalSessions(root: string): ListLocalSessionsResult {
  const sessions = listSessions(root);
  return {
    sessions: sessions.map((s) => ({
      session_id: s.sessionId,
      conversation_id: s.conversationId,
      mtime_ms: s.mtimeMs,
    })),
  };
}

export const listLocalSessionsTool: ToolDefinition = {
  name: 'list_local_sessions',
  description:
    'List local Cowork sessions on this machine, newest-first by mtime. ' +
    'Use this only when the user explicitly asks to browse or pick a ' +
    'session other than the current one — the default share flow does ' +
    'not need this tool. Returns an empty list when no sessions exist.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  handler: async (): Promise<ListLocalSessionsResult> => {
    return runListLocalSessions(defaultSessionsRoot());
  },
};
