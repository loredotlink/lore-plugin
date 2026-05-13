/**
 * lore-cowork MCP host — stdio entrypoint.
 *
 * Boots a low-level MCP `Server` over stdio with the `tools` capability
 * declared, then registers every tool exported from the `tools/` barrel.
 *
 * Why low-level `Server` rather than `McpServer`: matches the lore
 * monorepo's MCP entrypoint at `apps/api/src/mcp/server.ts`, which uses
 * the low-level API to wire `ListToolsRequest` and `CallToolRequest`
 * handlers explicitly. Keeping the surface consistent simplifies later
 * tool migration between the host and the API.
 *
 * Tool registration:
 *   - `ListToolsRequest` returns the barrel's entries projected to the
 *     SDK's wire shape (`name`, `description`, `inputSchema`).
 *   - `CallToolRequest` dispatches by name and wraps the handler's
 *     return value into a `CallToolResult`. JSON-serializable returns
 *     become a single text block (`JSON.stringify`'d); handlers that
 *     already produce a `CallToolResult` shape are passed through
 *     unchanged (forward-compat for tools that want structured content
 *     or `isError: true`).
 *   - Unknown names surface as `McpError(MethodNotFound, ...)`, the
 *     JSON-RPC-standard code for "this name doesn't resolve". Clients
 *     can re-list tools and try again.
 *
 * No scope check: unlike the HTTP-served API, a stdio host runs in the
 * user's own Claude process — anyone who can speak to the transport
 * is already the user. Auth is structural, not enforced in-band.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

import { tools } from './tools/index.js';

const SERVER_INFO = {
  name: 'lore-cowork-mcp',
  version: '0.1.0',
} as const;

/**
 * Wrap a tool handler's return into a `CallToolResult`. Handlers that
 * already return a CallToolResult-shaped object (with `content` or
 * `structuredContent`) are passed through; everything else is
 * `JSON.stringify`'d into a single text block. We never throw on
 * serialization — circular refs become an `isError: true` result so
 * the caller sees a tool error rather than a transport-level crash.
 */
function toCallToolResult(value: unknown): CallToolResult {
  if (
    value !== null &&
    typeof value === 'object' &&
    ('content' in value || 'structuredContent' in value)
  ) {
    return value as CallToolResult;
  }
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Tool returned a value that could not be serialized: ${
            (error as Error).message
          }`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text }],
  };
}

export async function main(): Promise<void> {
  const server = new Server(SERVER_INFO, {
    capabilities: {
      // Declare `tools` so the SDK accepts our tools/list and
      // tools/call handlers. Resources/prompts are not implemented.
      tools: {},
    },
  });

  const byName = new Map(tools.map((t) => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = byName.get(name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    const value = await tool.handler(args ?? {});
    return toCallToolResult(value);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only auto-boot when this module is the entrypoint. Importing from
// tests (or other modules) must NOT spin up a stdio transport — that
// would race with the test runner's own stdio.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
