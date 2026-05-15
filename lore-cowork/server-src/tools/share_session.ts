/**
 * MCP tool: `share_session`.
 *
 * Thin proxy over `callCloudTool('share_session', ...)`. Local plumbing:
 *   - Always merges `harness: 'cowork'` into the args passed cloud-side
 *     so the cloud aggregator records this thread under the "cowork"
 *     harness regardless of what the agent sends. The merge order
 *     deliberately puts the plugin's `harness` last, so even if a future
 *     schema change opened up an agent-controlled `harness` field, the
 *     plugin value wins.
 *   - Catches `AuthRequiredError` and returns the SDK's
 *     `authRequiredToMcpError()` shape so the agent can call
 *     `lore_login` and retry. Every other error bubbles to the
 *     dispatcher's catch-all in `index.ts`.
 *
 * Input schema:
 *   `properties` does NOT include `harness`. The dispatcher's
 *   `additionalProperties: false` check therefore rejects any agent
 *   attempt to override it. This is the schema-layer half of the
 *   defense-in-depth pair; the merge-order rule above is the runtime
 *   half.
 */
import type { ToolDefinition } from '../lib/tool.js';
import { callCloudTool } from '../lib/cloudCall.js';
import { AuthRequiredError, authRequiredToMcpError } from '../lib/errors.js';

export type ShareSessionResult = {
  thread_id: string;
  thread_url: string;
};

/**
 * Pure core: invoke `callCloudTool` with the harness merged in.
 * Exported for tests so they can verify the merge order and result
 * round-trip without mocking module-level globals.
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

export const shareSessionTool: ToolDefinition = {
  name: 'share_session',
  description:
    "Share the current session to Lore. Requires authentication via " +
    "lore_login on first use. Returns {thread_id, thread_url}. Always " +
    "called with harness 'cowork' on this plugin (set automatically).",
  inputSchema: {
    type: 'object',
    properties: {
      transcript: { type: 'string' },
    },
    required: ['transcript'],
    additionalProperties: false,
  },
  handler: async (args: unknown): Promise<unknown> => {
    // Dispatcher validates against inputSchema before invoking the
    // handler, so by the time we get here the cast is safe.
    return runShareSession(args as Record<string, unknown>);
  },
};
