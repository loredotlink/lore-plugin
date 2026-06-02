/**
 * JSON-RPC proxy to the cloud MCP server (`${cloudBaseUrl()}/mcp`).
 *
 * Why this module exists:
 *   Every proxy tool (share_session, get_thread, list_threads,
 *   fork_thread, search_threads) shares the same five lines of plumbing: get a bearer
 *   token, build a JSON-RPC envelope with a fresh id, POST it, handle
 *   401 specifically, propagate everything else. Centralizing here lets
 *   each tool be a thin pass-through.
 *
 * Why 401 is special-cased:
 *   `getValidAccessToken()` already refreshes the local token if it
 *   thinks it's expired. A 401 from the cloud despite a fresh token
 *   means the cloud revoked the refresh token (or the access token) in
 *   between — typically because the user logged out from another device
 *   or an admin revoked the session. In that case the only path forward
 *   is `lore_login` again, so we wipe the on-disk tokens and raise
 *   `AuthRequiredError`. Any other non-2xx is propagated as-is — the
 *   caller (or the agent on retry) might recover.
 *
 * Why we don't catch AuthRequiredError here:
 *   The per-tool dispatcher maps `AuthRequiredError` into a
 *   `CallToolResult` via `authRequiredToMcpError()`. Catching here would
 *   require knowing the tool name and duplicating that mapping. Letting
 *   it propagate keeps the chokepoint where it already is.
 *
 * Why a unique id per call:
 *   The MCP server checks for duplicate ids over a session window.
 *   Re-using a hardcoded id (e.g. `1`) for every request would conflate
 *   responses if two tool calls overlap in the same Bun process. UUIDs
 *   are cheap and remove that whole class of bug.
 */

import { randomUUID } from 'node:crypto';
import { AuthRequiredError } from './errors';
import { getValidAccessToken } from './auth/refresh.js';
import { deleteTokens } from './auth/store.js';
import { cloudMcpBaseUrl } from './cloudBaseUrl';

interface Options {
  fetchImpl?: typeof fetch;
  home?: string;
}

interface JsonRpcSuccess<T> {
  jsonrpc: '2.0';
  id: string;
  result: T;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: string;
  error: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

/**
 * Maximum number of body characters included in a non-2xx error
 * message. The cloud sometimes echoes request input back in errors;
 * truncating bounds the worst case for log leakage and message size.
 */
const ERROR_BODY_EXCERPT_LIMIT = 512;

/**
 * Call a tool on the cloud MCP server. See module docstring for full
 * error contract.
 *
 * @param toolName  The cloud tool name (e.g. `'share_session'`).
 * @param args      The `params.arguments` object the cloud tool expects.
 * @param opts      `fetchImpl` and `home` exist for tests; production
 *                  callers pass nothing.
 * @returns         The `result` field of the JSON-RPC response, verbatim.
 */
export async function callCloudTool<TResult = unknown>(
  toolName: string,
  args: Record<string, unknown>,
  opts: Options = {},
): Promise<TResult> {
  // Acquire the token first. If this throws AuthRequiredError, we MUST
  // NOT touch the network — the test asserts `fetchImpl` was never
  // called. Letting the throw propagate naturally handles that.
  const token = await getValidAccessToken({ home: opts.home });
  const fetchFn = opts.fetchImpl ?? fetch;

  const envelope = {
    jsonrpc: '2.0' as const,
    id: randomUUID(),
    method: 'tools/call',
    params: {
      name: toolName,
      arguments: args,
    },
  };

  const url = `${cloudMcpBaseUrl()}/mcp`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(envelope),
  });

  if (res.status === 401) {
    // Cloud-side revocation. The tokens we held no longer work; wipe
    // them so the next call lands cleanly on the "no tokens" path.
    await deleteTokens(opts.home);
    throw new AuthRequiredError();
  }

  if (!res.ok) {
    // Pull a short body excerpt to make logs legible without echoing
    // megabytes if the cloud returned an HTML error page.
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      bodyText = '';
    }
    const excerpt =
      bodyText.length > ERROR_BODY_EXCERPT_LIMIT
        ? `${bodyText.slice(0, ERROR_BODY_EXCERPT_LIMIT)}…`
        : bodyText;
    throw new Error(
      `Cloud MCP call to "${toolName}" failed: HTTP ${res.status}${
        excerpt ? `; body: ${excerpt}` : ''
      }`,
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error('cloud response was not valid JSON-RPC');
  }

  if (
    !json ||
    typeof json !== 'object' ||
    (json as { jsonrpc?: unknown }).jsonrpc !== '2.0'
  ) {
    throw new Error('cloud response was not valid JSON-RPC');
  }

  const rpc = json as Partial<JsonRpcSuccess<TResult>> & Partial<JsonRpcError>;

  if (rpc.error) {
    const message = rpc.error.message ?? 'unknown cloud error';
    // Attach the code via `.cause` (Error's standard extension slot) so
    // upstream logs can surface it without us needing to invent another
    // field on the Error subclass.
    throw new Error(`Cloud MCP error from "${toolName}": ${message}`, {
      cause: { code: rpc.error.code, data: rpc.error.data },
    });
  }

  if (!('result' in rpc)) {
    throw new Error('cloud response was not valid JSON-RPC');
  }

  return rpc.result as TResult;
}
