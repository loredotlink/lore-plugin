/**
 * MCP tool: `share_session`.
 *
 * Local-resolve + cloud-proxy over `callCloudTool('share_session', ...)`.
 *
 * Why the agent never sees `transcript`:
 *   The plugin runs in the same process as the user's local session
 *   files, so it can read the transcript bytes off disk itself. The
 *   previous schema required the agent to pass `transcript` as a
 *   string argument, which meant the agent had to first call
 *   `read_local_session` and round-trip the entire transcript through
 *   its own context window before forwarding it here. That blew past
 *   tool-result limits on long sessions and triggered subagent
 *   fallback. The handler now resolves the session locally (same
 *   priority order as `read_local_session`: explicit `session_id` →
 *   `COWORK_SESSION_ID` → newest-by-mtime), reads the transcript from
 *   disk, and pipes it straight to the cloud. The agent only sees
 *   `{thread_id, thread_url}` come back.
 *
 * Local plumbing:
 *   - Always merges `harness: 'cowork'` into the args passed cloud-side
 *     so the cloud aggregator records this thread under the "cowork"
 *     harness regardless of what the agent sends. The merge order
 *     deliberately puts the plugin's `harness` last, so even if a
 *     future schema change opened up an agent-controlled `harness`
 *     field, the plugin value wins.
 *   - Catches `AuthRequiredError` and returns the SDK's
 *     `authRequiredToMcpError()` shape so the agent can call
 *     `lore_login` and retry. Every other error bubbles to the
 *     dispatcher's catch-all in `index.ts`.
 *
 * Input schema:
 *   `properties` exposes only `session_id`. The dispatcher's
 *   `additionalProperties: false` rejects any agent attempt to pass
 *   `transcript`, `harness`, or anything else — neither field is part
 *   of the agent-visible contract any more. This is the schema-layer
 *   half of the defense-in-depth pair; the merge-order rule above is
 *   the runtime half.
 */
import type { ToolDefinition } from '../lib/tool.js';
import { callCloudTool } from '../lib/cloudCall.js';
import { AuthRequiredError, authRequiredToMcpError } from '../lib/errors.js';
import { defaultSessionsRoot } from '../lib/session.js';
import { runReadLocalSession } from './readLocalSession.js';

export type ShareSessionResult = {
  thread_id: string;
  thread_url: string;
};

export type ShareSessionArgs = {
  session_id?: string;
};

/**
 * Pure cloud-call core: invoke `callCloudTool` with the harness
 * merged in. Exported for tests so they can verify the merge order
 * and result round-trip without mocking module-level globals or
 * staging session files on disk.
 */
export async function runShareSession(
  args: Record<string, unknown>,
  opts: { fetchImpl?: typeof fetch; home?: string } = {},
): Promise<unknown> {
  try {
    // Plugin-controlled `harness` is spread LAST so it overrides any
    // (currently impossible, but defense-in-depth) caller-supplied
    // value. See module docstring.
    return await callCloudTool<ShareSessionResult>(
      'share_session',
      { ...args, harness: 'cowork' },
      opts,
    );
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return authRequiredToMcpError();
    }
    throw err;
  }
}

/**
 * Handler orchestration: resolve the target Cowork session on the
 * local filesystem, read its transcript, and forward to the cloud
 * `share_session` tool. The resolved transcript never appears in the
 * agent's tool-result stream — only the final `{thread_id, thread_url}`
 * (or auth-required shape) does.
 *
 * Dependency injection (`sessionsRoot`, `env`) exists so tests can
 * stage a fake session under a tmpdir without mutating `process.env`
 * or `os.homedir()`. The production handler closes over
 * `defaultSessionsRoot()` and `process.env` lazily.
 *
 * Errors:
 *   - `runReadLocalSession` throws `McpError(InvalidParams)` when no
 *     session can be resolved (no arg, no env, no sessions on disk)
 *     or when the explicit id doesn't exist. Those propagate verbatim.
 *   - Auth + cloud errors are handled inside `runShareSession`.
 */
export async function shareSessionFromDisk(
  args: ShareSessionArgs,
  opts: {
    fetchImpl?: typeof fetch;
    home?: string;
    sessionsRoot?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<unknown> {
  const sessionsRoot = opts.sessionsRoot ?? defaultSessionsRoot(opts.home);
  const env = opts.env ?? process.env;
  const session = runReadLocalSession({
    root: sessionsRoot,
    args: { session_id: args.session_id },
    env,
  });
  return runShareSession(
    { transcript: session.transcript },
    { fetchImpl: opts.fetchImpl, home: opts.home },
  );
}

export const shareSessionTool: ToolDefinition = {
  name: 'share_session',
  description:
    "Share the current Cowork session to Lore. With no arguments, " +
    "resolves to the newest local session by mtime (or, if set, the " +
    "session named by the COWORK_SESSION_ID env var). Pass " +
    "`session_id` to share a specific older session — typically one " +
    "surfaced by `list_local_sessions`. Requires authentication via " +
    "lore_login on first use. Returns {thread_id, thread_url}. " +
    "Always called with harness 'cowork' on this plugin (set " +
    "automatically). The plugin reads the transcript off disk " +
    "itself; the agent does not need to fetch it first.",
  inputSchema: {
    type: 'object',
    properties: {
      session_id: { type: 'string' },
    },
    additionalProperties: false,
  },
  handler: async (args: unknown): Promise<unknown> => {
    // Dispatcher validates against inputSchema before invoking the
    // handler, so by the time we get here the cast is safe.
    return shareSessionFromDisk((args ?? {}) as ShareSessionArgs);
  },
};
