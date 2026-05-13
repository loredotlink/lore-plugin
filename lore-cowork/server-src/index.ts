/**
 * lore-cowork MCP host — stdio entrypoint.
 *
 * Boots a low-level MCP `Server` over stdio with the `tools` capability
 * declared. No tools are registered yet; subsequent tasks add tool
 * handlers (Tasks 3/4/5 register read/write/admin tools).
 *
 * Why low-level `Server` rather than `McpServer`: matches the lore
 * monorepo's MCP entrypoint at `apps/api/src/mcp/server.ts`, which uses
 * the low-level API to wire `ListToolsRequest` and `CallToolRequest`
 * handlers explicitly. Keeping the surface consistent simplifies later
 * tool migration between the host and the API.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const SERVER_INFO = {
  name: 'lore-cowork-mcp',
  version: '0.1.0',
} as const;

export async function main(): Promise<void> {
  const server = new Server(SERVER_INFO, {
    capabilities: {
      // Declare `tools` so the SDK accepts our tools/list handler.
      // Resources/prompts are not implemented.
      tools: {},
    },
  });

  // Tool registration intentionally empty here; subsequent tasks add
  // tools. Wire `tools/list` returning an empty array so clients can
  // still discover capabilities without erroring.
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [],
  }));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
