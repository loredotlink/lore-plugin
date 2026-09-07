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
  type McpGeneratedToolSpec,
  type McpTextCallToolResult,
} from '@lore/contracts/mcp';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

import { callCloudTool, CloudMcpError } from '../lib/cloudCall.js';
import {
  AuthRequiredError,
  authRequiredToMcpError,
  toolExecutionError,
} from '../lib/errors.js';
import type { ToolDefinition, ToolInputSchema } from '../lib/tool.js';

export async function runCloudProxyTool(
  toolName: string,
  args: Record<string, unknown>,
  opts: { fetchImpl?: typeof fetch; home?: string; notFoundMessage?: string } = {},
): Promise<McpTextCallToolResult> {
  try {
    return await callCloudTool(toolName, args, opts);
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return authRequiredToMcpError();
    }
    if (
      err instanceof CloudMcpError &&
      err.code === ErrorCode.InvalidParams &&
      opts.notFoundMessage !== undefined &&
      err.message === opts.notFoundMessage
    ) {
      return toolExecutionError(
        `${opts.notFoundMessage}. Check the thread ID and your access, then retry.`,
      );
    }
    throw err;
  }
}

export const buildCloudProxyTool = (spec: McpGeneratedToolSpec): ToolDefinition => ({
  name: spec.name,
  description: spec.description,
  inputSchema: spec.inputSchema as ToolInputSchema,
  handler: async (args: unknown, opts): Promise<unknown> =>
    runCloudProxyTool(spec.name, (args ?? {}) as Record<string, unknown>, {
      fetchImpl: opts?.fetchImpl,
      home: opts?.home,
      notFoundMessage: spec.notFoundMessage,
    }),
});

export const cloudProxyTools: ToolDefinition[] = [
  ...buildMcpContractToolSpecs().map(buildCloudProxyTool),
  buildCloudProxyTool(mcpSearchThreadsToolSpec),
];
