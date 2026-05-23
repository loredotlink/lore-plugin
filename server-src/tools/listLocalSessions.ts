/**
 * MCP tool: `list_local_sessions`.
 *
 * Enumerates every session under the detected sessions root,
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
 *     `additionalProperties: false` so the dispatcher in `index.ts`
 *     rejects callers that try to narrow the listing — this keeps the
 *     tool surface trivial to reason about. The SDK itself does NOT
 *     enforce inputSchema against `arguments`; the plugin validates
 *     in `index.ts` and throws `McpError(InvalidParams)` on mismatch.
 *     See `lib/tool.ts` for the SDK-side citation.
 *   - Return is a plain JSON-serializable object: every field maps to
 *     a number or snake_case string. No Date instances.
 *
 * Testability:
 *   The pure `runListLocalSessions(source)` is exported separately so
 *   unit tests can exercise the mapping + ordering against tmpdir
 *   fixtures by injecting a `SessionSource` with a custom root.
 *   The exported `listLocalSessionsTool.handler` is the production wiring
 *   that calls `detectSource()` — it cannot be redirected, matching the
 *   "no env vars or arguments" constraint.
 */
import { detectSource, type SessionSource } from '../lib/session/index.js';
import type { ToolDefinition } from '../lib/tool.js';

export type ListLocalSessionsResult = {
  sessions: Array<{
    session_id: string;
    conversation_id: string;
    mtime_ms: number;
  }>;
};

/**
 * Pure core: given a SessionSource, return the mapped, newest-first
 * listing. Used by the tool handler and exercised directly by tests.
 */
export function runListLocalSessions(source: SessionSource): ListLocalSessionsResult {
  const sessions = source.listSessions();
  return {
    sessions: sessions.map((s) => ({
      session_id: s.sessionId,
      conversation_id: s.conversationId ?? '',
      mtime_ms: s.mtimeMs,
    })),
  };
}

export const listLocalSessionsTool: ToolDefinition = {
  name: 'list_local_sessions',
  description:
    'List local sessions on this machine, newest-first by mtime. ' +
    'Use this only when the user explicitly asks to browse or pick a ' +
    'session other than the current one — the default share flow does ' +
    'not need this tool. Returns an empty list when no sessions exist.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  handler: async (): Promise<ListLocalSessionsResult> => {
    return runListLocalSessions(detectSource());
  },
};
