/**
 * Generates local stdio tools for cloud-owned MCP tools.
 *
 * The plugin does not reimplement read/search behavior. It exposes the shared
 * specs locally, obtains or refreshes a Lore bearer token, and forwards calls
 * to the cloud /mcp server. Local-only tools and share_session remain custom.
 */
import {
  buildMcpContractToolSpecs,
  mcpSearchThreadsToolSpec,
  type McpStaticToolSpec,
  type McpTextCallToolResult,
} from '@lore/contracts/mcp';

import { callCloudTool } from '../lib/cloudCall.js';
import { AuthRequiredError, authRequiredToMcpError } from '../lib/errors.js';
import type { ToolDefinition, ToolInputSchema } from '../lib/tool.js';

export async function runCloudProxyTool(
  toolName: string,
  args: Record<string, unknown>,
  opts: { fetchImpl?: typeof fetch; home?: string } = {},
): Promise<McpTextCallToolResult> {
  try {
    return await callCloudTool(toolName, args, opts);
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return authRequiredToMcpError();
    }
    throw err;
  }
}

export const buildCloudProxyTool = (spec: McpStaticToolSpec): ToolDefinition => ({
  name: spec.name,
  description: spec.description,
  inputSchema: spec.inputSchema as ToolInputSchema,
  handler: async (args: unknown): Promise<unknown> =>
    runCloudProxyTool(spec.name, (args ?? {}) as Record<string, unknown>),
});

export const cloudProxyTools: ToolDefinition[] = [
  ...buildMcpContractToolSpecs().map(buildCloudProxyTool),
  buildCloudProxyTool(mcpSearchThreadsToolSpec),
];
