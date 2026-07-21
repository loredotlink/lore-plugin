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
 * Why 401 is special-cased (retry-before-delete):
 *   `getValidAccessToken()` already refreshes the local token if it
 *   thinks it's expired. A 401 from the cloud despite a locally-valid
 *   token can mean the access token was revoked/expired server-side, or
 *   another client rotated the session — but it can ALSO be a transient
 *   edge (clock skew right after a refresh, an audience-fallback miss, a
 *   momentary cloud auth blip). Deleting the session on the first 401
 *   turned all of those into a forced re-login, which was the "keeps
 *   logging me out" bug. So we now force ONE refresh and retry the call
 *   once. Only if the freshly-refreshed token is ALSO rejected do we
 *   conclude the session is dead, wipe the on-disk tokens, and raise
 *   `AuthRequiredError`. A dead refresh token surfaces as
 *   `AuthRequiredError` from `forceRefreshAccessToken` (it wipes there);
 *   a transient refresh failure propagates verbatim WITHOUT wiping, so
 *   the caller can retry later. Any other non-2xx is propagated as-is.
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

import {
  mcpTextCallToolResultSchema,
  type McpTextCallToolResult,
} from '@lore/contracts/mcp';
import { randomUUID } from 'node:crypto';
import { AuthRequiredError } from './errors';
import { getValidAccessToken, forceRefreshAccessToken } from './auth/refresh.js';
import { deleteTokens } from './auth/store.js';
import { cloudMcpBaseUrl } from './cloudBaseUrl';

interface Options {
  fetchImpl?: typeof fetch;
  home?: string;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string;
  result: unknown;
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
 * @returns         A validated MCP text `CallToolResult` from the cloud.
 */
export async function callCloudTool(
  toolName: string,
  args: Record<string, unknown>,
  opts: Options = {},
): Promise<McpTextCallToolResult> {
  // Acquire the token first. If this throws AuthRequiredError, we MUST
  // NOT touch the network — the test asserts `fetchImpl` was never
  // called. Letting the throw propagate naturally handles that.
  const token = await getValidAccessToken({ home: opts.home, fetchImpl: opts.fetchImpl });
  const fetchFn = opts.fetchImpl ?? fetch;

  const url = `${cloudMcpBaseUrl()}/mcp`;
  // Build a fresh JSON-RPC envelope (with a new unique id) per attempt, so a
  // retry after a 401 never reuses the first attempt's id.
  const postWithToken = (bearer: string): Promise<Response> => {
    const envelope = {
      jsonrpc: '2.0' as const,
      id: randomUUID(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args,
      },
    };
    return fetchFn(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(envelope),
    });
  };

  let res = await postWithToken(token);

  if (res.status === 401) {
    // Retry-before-delete (see module docstring). Force one refresh and retry
    // once. `forceRefreshAccessToken` wipes + throws AuthRequiredError on a
    // dead refresh token, and throws verbatim (tokens preserved) on a
    // transient refresh failure — either way we do NOT reach the delete below
    // unless the retry itself 401s.
    const refreshedToken = await forceRefreshAccessToken({
      previousAccessToken: token,
      home: opts.home,
      fetchImpl: opts.fetchImpl,
    });
    res = await postWithToken(refreshedToken);
    if (res.status === 401) {
      // Confirmed: even a freshly refreshed access token is rejected. The
      // session is genuinely dead; wipe so the next call lands cleanly on the
      // "no tokens" path.
      await deleteTokens(opts.home);
      throw new AuthRequiredError();
    }
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

  const rpc = json as Partial<JsonRpcSuccess> & Partial<JsonRpcError>;

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

  const result = mcpTextCallToolResultSchema.safeParse(rpc.result);
  if (!result.success) {
    throw new Error('cloud response was not a valid MCP tool result');
  }

  return result.data;
}
