/**
 * MCP tool: `list_threads`.
 *
 * Thin pass-through to the cloud's `list_threads`. Both args are
 * optional — the cloud applies its own defaults (typically `limit=20`
 * and `cursor=null` for first page). The plugin re-uses the cloud's
 * pagination semantics verbatim.
 */
import type { ToolDefinition } from '../lib/tool.js';
import { callCloudTool } from '../lib/cloudCall.js';
import { AuthRequiredError, authRequiredToMcpError } from '../lib/errors.js';

export async function runListThreads(
  args: Record<string, unknown>,
  opts: { fetchImpl?: typeof fetch; home?: string } = {},
): Promise<unknown> {
  try {
    return await callCloudTool('list_threads', args, opts);
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return authRequiredToMcpError();
    }
    throw err;
  }
}

export const listThreadsTool: ToolDefinition = {
  name: 'list_threads',
  description:
    'List recent Lore threads in your workspaces. Requires authentication via lore_login on first use.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'integer' },
      cursor: { type: 'string' },
    },
    additionalProperties: false,
  },
  handler: async (args: unknown): Promise<unknown> => {
    return runListThreads((args ?? {}) as Record<string, unknown>);
  },
};
