/**
 * Auth-required error type and its MCP tool-result mapping.
 *
 * Why this module exists as a leaf:
 *   Later modules (`refresh.ts`, `cloudCall.ts`, the proxy tools that
 *   forward `share_session`, `get_thread`, etc. to the cloud MCP) throw
 *   `AuthRequiredError` when a request can't be authenticated — either
 *   because no tokens are on disk, or because the cloud returned 401
 *   after a refresh attempt. The proxy tool's `catch` block translates
 *   that into a `CallToolResult` via `authRequiredToMcpError()` so the
 *   agent sees a regular tool result (not a JSON-RPC error) and can
 *   read the message to learn what to do next.
 *
 *   Keeping these types in a leaf module — with no imports from the
 *   rest of the plugin — means the refresh/proxy modules can depend on
 *   us without worrying about cycles.
 *
 * Why a CallToolResult and not a thrown error:
 *   Throwing from a tool handler surfaces as `McpError` JSON-RPC noise
 *   — the agent sees "tool failed" without an actionable string. A
 *   `{ isError: true, content: [...] }` result is the SDK-blessed way
 *   to deliver a human-readable failure message to the model. The
 *   message literally names `lore_login` so the agent's next action is
 *   obvious without a separate prompt.
 *
 * Wire shape:
 *   `authRequiredToMcpError()` returns an object that already matches
 *   `CallToolResult` (a `content` array with a single text block plus
 *   `isError: true`). The dispatcher in `index.ts:toCallToolResult`
 *   detects objects with a `content` field and passes them through
 *   unchanged, so this object reaches the agent verbatim.
 */

/**
 * Default message attached to an `AuthRequiredError` and to the
 * corresponding `CallToolResult`. Must literally contain `lore_login`
 * so the agent has a direct cue to invoke that tool next without
 * needing a separate system prompt.
 */
export const AUTH_REQUIRED_MESSAGE =
  'Not authenticated to Lore. Call lore_login first to authenticate, then retry this tool call.';

/**
 * Thrown by token-acquiring code paths (token load, refresh, cloud
 * call after a 401) when no valid credentials are available. Caught
 * by proxy tools and translated via `authRequiredToMcpError()`.
 *
 * Subclasses `Error` so that:
 *   - `instanceof AuthRequiredError` works in `catch` blocks,
 *   - `.message` and `.stack` are populated normally,
 *   - logs that print `error.name` show "AuthRequiredError" rather
 *     than the generic "Error".
 */
export class AuthRequiredError extends Error {
  constructor(message: string = AUTH_REQUIRED_MESSAGE) {
    super(message);
    // Restore the prototype chain for `instanceof` after transpilation —
    // some target configurations break the chain when extending built-ins.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'AuthRequiredError';
  }
}

/**
 * Map an auth-required failure into the `CallToolResult` shape the
 * dispatcher in `index.ts:toCallToolResult` will pass through
 * unchanged. The return type is narrowed (`isError: true`, single text
 * block) rather than the broader `CallToolResult` because callers want
 * to construct a fixed shape — not pick from a union.
 */
export function authRequiredToMcpError(): {
  isError: true;
  content: [{ type: 'text'; text: string }];
} {
  return {
    isError: true,
    content: [{ type: 'text', text: AUTH_REQUIRED_MESSAGE }],
  };
}
