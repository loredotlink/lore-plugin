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
 * SDK validation gap:
 *   The `@modelcontextprotocol/sdk` validates only the JSON-RPC
 *   envelope for `tools/call` — see
 *   `node_modules/@modelcontextprotocol/sdk/dist/esm/types.js`
 *   (`CallToolRequestParamsSchema`), which declares `arguments` as
 *   `z.record(z.string(), z.unknown()).optional()`. It does NOT check
 *   the request's `arguments` against the tool's `inputSchema`. The
 *   `tools/call` wrapped handler in
 *   `node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js`
 *   (around line 117) re-validates with `CallToolRequestSchema` and
 *   forwards to the handler with raw `arguments`. So the plugin itself
 *   enforces schema conformance — see `validateAgainstSchema` in
 *   `server-src/index.ts`.
 *
 * Handlers return any JSON-serializable value. The server registration
 * in `index.ts` wraps the return into a `CallToolResult` with a single
 * text block (`JSON.stringify`'d), matching the SDK's "structured
 * output via JSON in text" convention.
 */

/**
 * Tool input schema — a tightened subset of JSON Schema 7 covering the
 * features V1 tools actually use. The manual validator in `index.ts`
 * understands exactly these fields; deliberately no index signature,
 * so adding a new feature (e.g. `oneOf`) is a typed change that forces
 * a paired update to the validator.
 */
export type ToolInputSchema = {
  type: 'object';
  /** Per-property JSON Schema fragments. Values are typed as `unknown`
   * because the manual validator only understands a small subset of
   * Schema-7 features — keeping the inner shape opaque prevents
   * accidental claims of full-JSON-Schema support at the type level. */
  properties?: Record<string, unknown>;
  /** When `false`, callers may not include any field not listed in
   * `properties`. The validator in `index.ts` enforces this — the SDK
   * itself does not. */
  additionalProperties?: boolean | object;
  /** Names of fields that must be present in `arguments`. */
  required?: string[];
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  handler: (args: unknown) => Promise<unknown>;
};
