/**
 * Tool definition shape for the lore-cowork MCP host.
 *
 * Mirrors the shape used in the lore monorepo's MCP entrypoint
 * (`apps/api/src/mcp/server.ts`) but trimmed to what a local stdio
 * server needs:
 *   - no `requiredScope`: there is no auth boundary on a stdio host
 *     running inside the user's own Claude process. Anyone who can
 *     speak to this transport is already the user.
 *   - no `outputSchema`: V1 tools return JSON-serializable values that
 *     `index.ts` wraps into a `CallToolResult` text block; structured
 *     output schemas can be added later without changing this shape.
 *
 * Handlers return any JSON-serializable value. The server registration
 * in `index.ts` wraps the return into a `CallToolResult` with a single
 * text block (`JSON.stringify`'d), matching the SDK's "structured
 * output via JSON in text" convention.
 */
export type ToolDefinition = {
  name: string;
  description: string;
  /** JSON Schema (object) describing the tool's arguments. */
  inputSchema: { type: 'object'; [key: string]: unknown };
  handler: (args: unknown) => Promise<unknown>;
};
