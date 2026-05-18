/**
 * MCP tool: `search_threads`.
 *
 * Thin pass-through to the cloud's `search_threads`. `query` is
 * required (enforced by the dispatcher's schema validator before the
 * handler runs); `limit` is optional and forwarded as-is.
 */
import type { ToolDefinition } from '../lib/tool.js';
import { callCloudTool } from '../lib/cloudCall.js';
import { AuthRequiredError, authRequiredToMcpError } from '../lib/errors.js';

export async function runSearchThreads(
  args: Record<string, unknown>,
  opts: { fetchImpl?: typeof fetch; home?: string } = {},
): Promise<unknown> {
  try {
    return await callCloudTool('search_threads', args, opts);
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return authRequiredToMcpError();
    }
    throw err;
  }
}

export const searchThreadsTool: ToolDefinition = {
  name: 'search_threads',
  description:
    'Search Lore threads by title across your workspaces. Requires authentication via lore_login on first use.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'integer' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  handler: async (args: unknown): Promise<unknown> => {
    return runSearchThreads(args as Record<string, unknown>);
  },
};
