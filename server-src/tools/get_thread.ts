/**
 * MCP tool: `get_thread`.
 *
 * Thin pass-through to the cloud's `get_thread` tool — the cloud owns
 * the actual fetch logic against the Lore database; the plugin just
 * adds the bearer token and translates auth failures into the MCP
 * `CallToolResult` shape so the agent has a legible cue to call
 * `lore_login`.
 */
import type { ToolDefinition } from '../lib/tool.js';
import { callCloudTool } from '../lib/cloudCall.js';
import { AuthRequiredError, authRequiredToMcpError } from '../lib/errors.js';

/**
 * Pure core. Exported for tests.
 */
export async function runGetThread(
  args: Record<string, unknown>,
  opts: { fetchImpl?: typeof fetch; home?: string } = {},
): Promise<unknown> {
  try {
    return await callCloudTool('get_thread', args, opts);
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return authRequiredToMcpError();
    }
    throw err;
  }
}

export const getThreadTool: ToolDefinition = {
  name: 'get_thread',
  description:
    'Fetch a Lore thread by id. Requires authentication via lore_login on first use.',
  inputSchema: {
    type: 'object',
    properties: {
      thread_id: { type: 'string' },
    },
    required: ['thread_id'],
    additionalProperties: false,
  },
  handler: async (args: unknown): Promise<unknown> => {
    return runGetThread(args as Record<string, unknown>);
  },
};
