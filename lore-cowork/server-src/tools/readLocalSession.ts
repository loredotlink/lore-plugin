/**
 * MCP tool: `read_local_session`.
 *
 * Returns the transcript bytes and artifact filenames the agent needs
 * to call the cloud `share_session` tool. This is the core of the
 * share flow.
 *
 * Session resolution priority (handler logic):
 *   1. Explicit `session_id` argument (if a non-empty / non-whitespace
 *      string) → look up that specific session in `listSessions(root)`.
 *   2. `COWORK_SESSION_ID` env var (if present and non-empty) →
 *      same lookup.
 *   3. Newest by mtime — `findLatestSession(root)`.
 *
 * The env var is read lazily from `process.env` on each call, NOT
 * captured at module load — this matches how tests (and users running
 * the host as a long-lived process) expect env mutations to take
 * effect immediately.
 *
 * Errors:
 *   - Specified session id not found (via arg or env): `McpError(InvalidParams)`
 *     with message `session not found: <id>`.
 *   - No sessions at all (no arg, no env, mtime resolution returns null):
 *     `McpError(InvalidParams, "no Cowork session found")`.
 *   - Lib-level errors from `readSession` (missing `local_*` subdir,
 *     missing transcript): `McpError(InvalidParams)` with the lib's
 *     message preserved so the agent can relay an actionable hint.
 *   - Other filesystem errors: `McpError(InternalError)`.
 *
 * Testability:
 *   `runReadLocalSession({ root, args, env })` is the pure core — tests
 *   pass a tmpdir-backed `root` and a controlled `env` object instead
 *   of mutating `process.env`. The production handler closes over
 *   `defaultSessionsRoot()` + `process.env` lazily.
 */
import {
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import {
  defaultSessionsRoot,
  findLatestSession,
  listSessions,
  readSession,
  type ListedSession,
} from '../lib/session.js';
import type { ToolDefinition } from '../lib/tool.js';

export type ReadLocalSessionArgs = {
  session_id?: string;
};

export type ReadLocalSessionResult = {
  session_id: string;
  conversation_id: string;
  transcript: string;
  uploads: string[];
  outputs: string[];
};

/** Treat empty string / whitespace as "not provided". */
function nonBlank(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : value;
}

/**
 * Resolve the target session per the documented priority. Throws
 * `McpError(InvalidParams)` when an explicit id (arg or env) does not
 * match a real session, or when there are no sessions at all.
 */
function resolveSession(
  root: string,
  args: ReadLocalSessionArgs,
  env: NodeJS.ProcessEnv,
): ListedSession {
  const explicitArg = nonBlank(args.session_id);
  if (explicitArg !== null) {
    const all = listSessions(root);
    const match = all.find((s) => s.sessionId === explicitArg);
    if (!match) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `session not found: ${explicitArg}`,
      );
    }
    return match;
  }

  const envId = nonBlank(env.COWORK_SESSION_ID);
  if (envId !== null) {
    const all = listSessions(root);
    const match = all.find((s) => s.sessionId === envId);
    if (!match) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `session not found: ${envId}`,
      );
    }
    return match;
  }

  const latest = findLatestSession(root);
  if (!latest) {
    throw new McpError(ErrorCode.InvalidParams, 'no Cowork session found');
  }
  return latest;
}

/**
 * Pure core: given a sessions root, args, and env, resolve and read
 * the target session. Used by the tool handler and exercised directly
 * by tests.
 */
export function runReadLocalSession(opts: {
  root: string;
  args: ReadLocalSessionArgs;
  env: NodeJS.ProcessEnv;
}): ReadLocalSessionResult {
  const session = resolveSession(opts.root, opts.args, opts.env);

  let contents;
  try {
    contents = readSession(session.sessionDir);
  } catch (err) {
    // Lib throws plain Error with actionable messages for the
    // structural cases (no `local_*` subdir, no transcript file).
    // Treat those as InvalidParams so the agent can relay the hint.
    // We can't reliably distinguish "structural" from "IO" errors by
    // type, but the lib only throws plain Errors for the structural
    // cases — any IO error (EACCES, EIO, etc.) surfaces as a node
    // SystemError, which we surface as InternalError. We approximate
    // the distinction by checking for a `code` property: SystemErrors
    // carry one (e.g. 'ENOENT', 'EACCES'); the lib's `new Error(...)`
    // does not.
    const e = err as Error & { code?: string };
    if (typeof e?.code === 'string' && e.code !== '') {
      throw new McpError(
        ErrorCode.InternalError,
        `failed to read session: ${e.message ?? String(e)}`,
      );
    }
    throw new McpError(
      ErrorCode.InvalidParams,
      e?.message ?? String(err),
    );
  }

  return {
    session_id: session.sessionId,
    conversation_id: session.conversationId,
    transcript: contents.transcript,
    uploads: contents.uploads,
    outputs: contents.outputs,
  };
}

export const readLocalSessionTool: ToolDefinition = {
  name: 'read_local_session',
  description:
    'Read a local Cowork session and return its transcript bytes plus ' +
    'the basenames of any uploaded inputs and generated outputs. With ' +
    'no arguments, resolves to the newest session by mtime (or, if set, ' +
    'the session named by the COWORK_SESSION_ID env var). Pass ' +
    '`session_id` explicitly to pick a specific session — typically a ' +
    'session_id surfaced by `list_local_sessions`.',
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string' },
    },
    additionalProperties: false,
  },
  handler: async (args: unknown): Promise<ReadLocalSessionResult> => {
    // The dispatcher in `index.ts` has already validated `args`
    // against `inputSchema`, so it's safe to narrow here.
    const typed = (args ?? {}) as ReadLocalSessionArgs;
    return runReadLocalSession({
      root: defaultSessionsRoot(),
      args: typed,
      env: process.env,
    });
  },
};
