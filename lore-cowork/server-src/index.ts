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

import type { ToolInputSchema } from './lib/tool.js';
import { tools } from './tools/index.js';

const SERVER_INFO = {
  name: 'lore-cowork-mcp',
  version: '0.1.0',
} as const;

/**
 * Validate `args` against a `ToolInputSchema`. Returns `null` when
 * valid, or a human-readable error string when not.
 *
 * Scope: this is the small JSON Schema 7 subset V1 tools actually use:
 *   - `type === 'object'` on the root (enforced by `ToolInputSchema`)
 *   - `required: string[]` — every named field must be present in args
 *   - `additionalProperties: false` — reject any field not in `properties`
 *   - per-property `type`: 'string' | 'number' | 'integer' | 'boolean'
 *
 * Why a hand-rolled validator instead of Ajv: Ajv is in `node_modules`
 * as a transitive dep of the SDK, but adding it as a direct dep just
 * to enforce four features is more surface than the four features
 * justify. If a future tool needs `oneOf` / `enum` / nested objects,
 * swap in Ajv or zod — `ToolInputSchema` deliberately has no index
 * signature so any new field forces a paired validator update.
 *
 * Why this lives in the dispatcher rather than each tool: the SDK's
 * `CallToolRequestSchema` only validates `arguments` as
 * `Record<string, unknown> | undefined` (see
 * `node_modules/@modelcontextprotocol/sdk/dist/esm/types.js`
 * line 1336). Without this gate, a caller could pass `{ sessionId: ...}`
 * to a tool whose schema declares `session_id`, and the handler would
 * silently see `undefined` — a real UX failure mode for the agent.
 */
export function validateAgainstSchema(
  schema: ToolInputSchema,
  args: unknown,
): string | null {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return `expected an object, got ${args === null ? 'null' : Array.isArray(args) ? 'array' : typeof args}`;
  }
  const obj = args as Record<string, unknown>;
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];

  for (const name of required) {
    if (!Object.prototype.hasOwnProperty.call(obj, name)) {
      return `missing required field '${name}'`;
    }
  }

  if (schema.additionalProperties === false) {
    for (const name of Object.keys(obj)) {
      if (!Object.prototype.hasOwnProperty.call(properties, name)) {
        return `unknown field '${name}' (additionalProperties: false)`;
      }
    }
  }

  for (const [name, propSchemaRaw] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(obj, name)) continue;
    const propSchema = propSchemaRaw as { type?: string };
    if (typeof propSchema?.type !== 'string') continue;
    const value = obj[name];
    const actual = typeof value;
    const expected = propSchema.type;
    let ok: boolean;
    switch (expected) {
      case 'string':
        ok = actual === 'string';
        break;
      case 'boolean':
        ok = actual === 'boolean';
        break;
      case 'number':
        ok = actual === 'number' && Number.isFinite(value as number);
        break;
      case 'integer':
        ok = actual === 'number' && Number.isInteger(value as number);
        break;
      default:
        // Unknown type keyword — be permissive rather than rejecting,
        // so a schema typo doesn't silently break a working tool.
        ok = true;
    }
    if (!ok) {
      return `field '${name}' expected ${expected}, got ${actual}`;
    }
  }

  return null;
}

/**
 * Wrap a tool handler's return into a `CallToolResult`. Handlers that
 * already return a CallToolResult-shaped object (with `content` or
 * `structuredContent`) are passed through; everything else is
 * `JSON.stringify`'d into a single text block. We never throw on
 * serialization — circular refs become an `isError: true` result so
 * the caller sees a tool error rather than a transport-level crash.
 */
export function toCallToolResult(value: unknown): CallToolResult {
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
    const argsObj = args ?? {};
    const error = validateAgainstSchema(tool.inputSchema, argsObj);
    if (error) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid arguments for tool '${name}': ${error}`,
      );
    }
    const value = await tool.handler(argsObj);
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
