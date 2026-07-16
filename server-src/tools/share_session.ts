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
 *   `CLAUDE_CODE_SESSION_ID` / `CLAUDE_SESSION_ID` / `COWORK_SESSION_ID`
 *   → newest-by-mtime),
 *   reads the transcript from disk, and pipes it straight to the cloud.
 *   The agent only sees `{thread_id, thread_url}` come back.
 *
 * Local plumbing:
 *   - Merges `harness` into the args passed cloud-side, derived from
 *     the detected runtime. The merge order deliberately puts the
 *     plugin's `harness` last, so even if a future schema change
 *     opened up an agent-controlled `harness` field, the plugin value
 *     wins.
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
import { mcpShareSessionPluginToolSpec } from '@lore/contracts/mcp';

import type { ToolDefinition } from '../lib/tool.js';
import { callCloudTool } from '../lib/cloudCall.js';
import { AuthRequiredError, authRequiredToMcpError } from '../lib/errors.js';
import { detectSource, type SessionSource } from '../lib/session/index.js';
import { runReadLocalSession } from './readLocalSession.js';
import { copyToClipboard } from '../lib/clipboard.js';
import {
  readPluginState,
  writePluginState,
  shouldShowWatcherTip,
} from '../lib/pluginState.js';

export const WATCHER_TIP =
  'Tip: install our macOS app (https://lore.link/docs/overview) to auto-share new sessions in the background.';

export type ShareSessionResult = {
  thread_id: string;
  thread_url: string;
  clipboard_copied?: boolean;
  highlight?: {
    query: string;
    matched: boolean;
    start_block_id: string | null;
    end_block_id: string | null;
  };
};

export type ShareSessionArgs = {
  session_id?: string;
  highlight?: string;
  title?: string;
};

/**
 * Map `SessionSource.runtime` values to the harness strings the Lore
 * cloud API accepts. The API uses camelCase (`claudeCode`) while the
 * internal runtime type uses kebab-case (`claude-code`).
 *
 * Codex has its own harness cloud-side, so Codex transcripts upload
 * as `codex`.
 */
const RUNTIME_TO_HARNESS: Record<string, string> = {
  'claude-code': 'claudeCode',
  cowork: 'cowork',
  codex: 'codex',
};

/**
 * Pure cloud-call core: invoke `callCloudTool` with the harness
 * merged in. Exported for tests so they can verify the merge order
 * and result round-trip without mocking module-level globals or
 * staging session files on disk.
 */
export async function runShareSession(
  args: Record<string, unknown>,
  opts: { fetchImpl?: typeof fetch; home?: string; harness?: string } = {},
): Promise<unknown> {
  try {
    const harness = opts.harness ?? 'cowork';
    // Plugin-controlled `harness` is spread LAST so it overrides any
    // (currently impossible, but defense-in-depth) caller-supplied
    // value. See module docstring.
    return await callCloudTool<ShareSessionResult>(
      'share_session',
      { ...args, harness },
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
 * Handler orchestration: resolve the target session on the local
 * filesystem (Claude Code, Cowork, or Codex), read its transcript,
 * and forward to the cloud `share_session` tool. The resolved
 * transcript never appears in the agent's tool-result stream — only
 * the final `{thread_id, thread_url}` (or auth-required shape) does.
 *
 * Dependency injection (`source`, `env`) exists so tests can pass a
 * `SessionSource` backed by a tmpdir without mutating `process.env`
 * or `os.homedir()`. The production handler calls `detectSource()`
 * lazily (and reads `process.env` lazily) on each invocation.
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
    source?: SessionSource;
    env?: NodeJS.ProcessEnv;
    copyToClipboard?: (text: string) => Promise<boolean>;
  } = {},
): Promise<unknown> {
  const source = opts.source ?? detectSource(opts.env);
  const env = opts.env ?? process.env;
  const session = runReadLocalSession({
    source,
    args: { session_id: args.session_id },
    env,
  });
  const highlight = args.highlight?.trim();
  const title = args.title?.trim();
  const result = await runShareSession(
    {
      transcript: session.transcript,
      uploads: session.uploads,
      outputs: session.outputs,
      ...(highlight ? { highlight } : {}),
      ...(title ? { title } : {}),
    },
    { fetchImpl: opts.fetchImpl, home: opts.home, harness: RUNTIME_TO_HARNESS[source.runtime] ?? source.runtime },
  );

  // If the share failed (auth-required shape), skip state mutation.
  if (
    result !== null &&
    typeof result === 'object' &&
    (result as Record<string, unknown>).isError === true
  ) {
    return result;
  }

  const resultWithClipboard = await attachClipboardStatus(
    result,
    opts.copyToClipboard ?? copyToClipboard,
  );

  // Read state, compute tip visibility, write incremented state.
  // Errors here must NOT fail the share — log to stderr and move on.
  let tipText: string | null = null;
  try {
    const state = await readPluginState(opts.home);
    const showTip = shouldShowWatcherTip(state);
    await writePluginState({ ...state, share_count: state.share_count + 1 }, opts.home);
    if (showTip) {
      tipText = WATCHER_TIP;
    }
  } catch (err) {
    console.error('[lore-plugin] warning: failed to update plugin state:', (err as Error).message);
  }

  if (tipText === null) {
    return resultWithClipboard;
  }

  // Append tip to content array if result is MCP content shape, otherwise
  // wrap both in a combined object.
  if (
    resultWithClipboard !== null &&
    typeof resultWithClipboard === 'object' &&
    Array.isArray((resultWithClipboard as Record<string, unknown>).content)
  ) {
    const r = resultWithClipboard as { content: unknown[] };
    return { ...r, content: [...r.content, { type: 'text', text: tipText }] };
  }

  // Result is a plain object (e.g. {thread_id, thread_url}); attach tip
  // as a separate property so the caller still gets the structured data.
  return { ...(resultWithClipboard as object), _tip: tipText };
}

async function attachClipboardStatus(
  result: unknown,
  copier: (text: string) => Promise<boolean>,
): Promise<unknown> {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }

  const threadUrl = (result as Record<string, unknown>).thread_url;
  if (typeof threadUrl !== 'string' || threadUrl.length === 0) {
    return result;
  }

  let clipboardCopied = false;
  try {
    clipboardCopied = await copier(threadUrl);
  } catch {
    clipboardCopied = false;
  }

  return { ...(result as object), clipboard_copied: clipboardCopied };
}

export const shareSessionTool: ToolDefinition = {
  name: mcpShareSessionPluginToolSpec.name,
  description: mcpShareSessionPluginToolSpec.description,
  inputSchema: mcpShareSessionPluginToolSpec.inputSchema,
  handler: async (args: unknown): Promise<unknown> => {
    // Dispatcher validates against inputSchema before invoking the
    // handler, so by the time we get here the cast is safe.
    return shareSessionFromDisk((args ?? {}) as ShareSessionArgs);
  },
};
