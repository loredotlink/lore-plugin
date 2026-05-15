# lore-cowork Device-Flow Auth (Plugin-Side) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task.

**Goal:** Replace the broken Cowork-driven OAuth path with a host-proxy
RFC 8628 device flow run by the `lore-cowork-local` stdio MCP binary, so
Cowork users can authenticate against `mcp.lore.tanagram.ai` and reach
the cloud `share_session` / `get_thread` / `list_threads` /
`search_threads` tools through the plugin.

**Architecture:** The stdio MCP binary grows two new auth tools
(`lore_login`, `lore_login_resume`) and four proxy tools that wrap the
cloud MCP tools with `Authorization: Bearer <jwt>`. All token reads
funnel through a single `getValidAccessToken()` with a module-scope
mutex; tokens persist to `~/Library/Application Support/tanagram/lore/tokens.json`
at mode 0600. The remote `lore` server entry leaves `.mcp.json` (the
cloud server itself is untouched and continues to serve direct clients).

**Tech Stack:** Bun runtime, TypeScript, `@modelcontextprotocol/sdk` low-level
`Server`, Zod v4 for token-file and tool-arg validation, Bun test runner.

**Design doc:** [docs/plans/2026-05-15-lore-cowork-device-flow-auth-design.md](docs/plans/2026-05-15-lore-cowork-device-flow-auth-design.md)

**Cloud dependency:** [tanagram/lore — 2026-05-15-oauth-device-flow-cloud.md](../../../lore/.claude/worktrees/hungry-leakey-a71a7b/docs/plans/2026-05-15-oauth-device-flow-cloud.md).
Cloud ships first; unit tests here mock the HTTP surface.

## Rationale

The work decomposes along the dependency graph implied by `lib/refresh.ts`
being the single chokepoint every proxy tool calls:

1. **Errors + tokens persistence** are pure helpers everything else
   imports — they go first so all later contracts can reference
   `AuthRequiredError` and the `TokensSchema` shape.
2. **Refresh-with-mutex** depends on tokens persistence and the error
   type. Lands before any caller of `getValidAccessToken()` exists, so
   tests can exercise the mutex semantics in isolation.
3. **Cloud-call helper** depends on the refresh module and the error
   type. Once this is in, the proxy tools become trivial wrappers.
4. **Auth tools** (`lore_login`, `lore_login_resume`) depend only on
   tokens persistence — they perform their own HTTP I/O against
   `/oauth/device/code` and `/oauth/token` directly, not via
   `cloudCall.ts`. Land them before proxy tools so the agent has a way
   to bootstrap credentials before any proxy call exists.
5. **Proxy tools** (parallel group) depend on the cloud-call helper and
   the error type. Each is independent of the others.
6. **Tool barrel + index wiring** depends on every tool above. One
   commit-sized change that exposes the new tools to the SDK dispatcher.
7. **`.mcp.json` and slash-command updates** depend on the tools being
   live in the binary. Without this step the agent still uses the
   broken remote server entry.
8. **Build + CI verification** locks the source-binary drift gate.
9. **End-to-end integration test against deployed cloud** is the final
   gate; runs only after the cloud-side plan has landed.

Tasks 5a–5d are explicitly parallel. The rest are serial because each
relies on contracts from the previous step.

The cloud HTTP surface is mocked in unit tests via Bun's `globalThis.fetch`
stub pattern — the test mocks `/oauth/device/code`, `/oauth/token`, and
the cloud `/mcp` JSON-RPC endpoint. The same mock harness is shared
across `refresh.test.ts`, `cloudCall.test.ts`, `lore_login.test.ts`, and
the proxy-tool tests; it lives in `server-src/lib/__testhelpers__/cloudMock.ts`.

## Pre-flight notes

**Worktree state:** This worktree has merged latest `origin/main`. The
stale uncommitted `.mcp.json` change in the user's main tree has been
superseded — current main already carries the `type: stdio` / `type: http`
schema fix and the `mcp.lore.tanagram.ai/mcp` URL. Task 9 below removes
the `lore` server entry from that file.

**Cloud-side dependency is parallel, not blocking.** The cloud-side
plan (`tanagram/lore:docs/plans/2026-05-15-oauth-device-flow-cloud.md`)
ships in parallel with this work. Plugin-side unit tests mock the cloud
HTTP surface entirely (no network). End-to-end testing (Task 12) runs
locally against the lore dev stack, not against production.

## Local development testing

The lore monorepo runs locally per `tanagram/lore:CONTRIBUTING.md`:
`pnpm dev` in `/Users/quentindonnelly/repos/lore` starts the API on
`http://localhost:4000` and the web app on `http://localhost:8080`,
backed by the shared Railway dev DB. The OAuth endpoints the plugin
calls (`POST /oauth/device/code`, `POST /oauth/token`) and the MCP
endpoint (`POST /mcp`) all live under that same `:4000` origin in dev,
matching prod's `https://mcp.lore.tanagram.ai/{oauth/*,mcp}` structure.

To make the plugin testable against either prod or local dev without
recompiling the binary, **every cloud URL is derived from a single
helper `cloudBaseUrl()` that reads the `LORE_MCP_BASE_URL` env var**,
defaulting to `https://mcp.lore.tanagram.ai`. Set
`LORE_MCP_BASE_URL=http://localhost:4000` in the Cowork environment
(or wherever Claude Code launches the binary) when working against
local dev. The env var name mirrors lore's `LORE_OAUTH_ISSUER` /
`LORE_OAUTH_AUDIENCE` naming convention from
`apps/api/src/env.ts`.

The helper is **read-once at module load** (not per-call) so a single
binary process has a stable base URL across the full session — a
mid-session env mutation would otherwise break the mutex invariant in
`refresh.ts` (two refreshes hitting different origins simultaneously).

## Task 1: `lib/errors.ts` — auth-required error type and MCP mapping

**Why:** Every other module references `AuthRequiredError` and the
shared message string. Land the pure types first so subsequent contracts
compile without circular concerns.

**Files:**
- Create: `lore-cowork/server-src/lib/errors.ts`
- Create: `lore-cowork/server-src/lib/errors.test.ts`

**Contract:**

```ts
export class AuthRequiredError extends Error {
  constructor(message?: string);
}

export const AUTH_REQUIRED_MESSAGE: string;

export function authRequiredToMcpError(): {
  isError: true;
  content: [{ type: 'text'; text: string }];
};
```

`AUTH_REQUIRED_MESSAGE` must literally name `lore_login` so the agent
has a direct cue. The `authRequiredToMcpError()` return must match the
shape `index.ts:toCallToolResult` already passes through unchanged
(it tests for `'content' in value || 'structuredContent' in value`).

**Acceptance:**
- `AuthRequiredError` is throwable, catchable via `instanceof`, and
  retains `.message` and `.stack`.
- `authRequiredToMcpError()` returns an object with `isError: true` and
  exactly one text content block whose text is `AUTH_REQUIRED_MESSAGE`.
- The returned object, when fed through `index.ts:toCallToolResult`, is
  passed through unchanged (verified by a single integration assertion
  in this test file, importing `toCallToolResult` from `../index.js`).
- Message string contains the literal substring `"lore_login"`.

**Constraints:**
- No runtime dependencies on any other plugin module — pure types.
- No `console.*` calls; the binary speaks JSON-RPC on stdout, so any
  stray write to stdout corrupts the transport.

## Task 2: `lib/tokens.ts` — disk persistence with atomic write + Zod validation

**Why:** Both `lib/refresh.ts` and `tools/lore_login.ts` mutate the
tokens file. Centralizing read/write here keeps schema validation,
permissions, and atomic-write semantics in one place.

**Files:**
- Create: `lore-cowork/server-src/lib/tokens.ts`
- Create: `lore-cowork/server-src/lib/tokens.test.ts`
- Modify: `lore-cowork/package.json` — add `zod` (^4) to `devDependencies`
  (the binary is single-file-compiled, so `dependencies` vs `devDependencies`
  is immaterial; match the existing convention of `devDependencies` only).

**Contract:**

```ts
import { z } from 'zod';

export const TokensSchema: z.ZodObject<{
  access_token: z.ZodString;
  refresh_token: z.ZodString;
  expires_at: z.ZodNumber;  // epoch ms, integer
  scope: z.ZodString;
}>;

export type Tokens = z.infer<typeof TokensSchema>;

/** Returns absolute path under `~/Library/Application Support/...`.
 *  Accepts a `home` override for tests. */
export function tokensFilePath(home?: string): string;

/** Returns null when file does not exist. Throws on read errors,
 *  permission errors, or schema-validation failures (fail loud). */
export async function readTokens(home?: string): Promise<Tokens | null>;

/** Writes atomically: write to `<path>.tmp`, fsync, rename. Creates
 *  the parent directory with mode 0700 if it doesn't exist. Sets the
 *  file mode to 0600 after write. */
export async function writeTokens(tokens: Tokens, home?: string): Promise<void>;

/** Removes the tokens file if present; no-op if absent. Does not
 *  touch the parent directory. */
export async function deleteTokens(home?: string): Promise<void>;
```

**Acceptance:**
- `tokensFilePath()` returns
  `<home>/Library/Application Support/tanagram/lore/tokens.json`.
- `readTokens()` returns `null` when the file is absent (and absent
  parent dir).
- `readTokens()` throws when the file exists but content is not valid
  JSON or fails `TokensSchema`. The thrown error references the schema
  failure (Zod's `.format()` output or equivalent).
- `writeTokens()` creates the parent directory tree if missing.
- After `writeTokens()`, `fs.statSync(path).mode & 0o777 === 0o600`
  and `fs.statSync(parent).mode & 0o777 === 0o700`.
- Atomicity: an interrupted write (simulate by failing the rename) leaves
  the original file untouched. Test by pre-populating with valid tokens,
  then asserting `readTokens()` still returns the original after a
  rename-failure injection.
- Concurrent `writeTokens()` from two awaited calls in the same process
  never produces a corrupted file (the second write fully replaces the
  first; readers always see a complete file).
- `deleteTokens()` is idempotent — calling on a missing file resolves
  without error.
- `expires_at` schema rejects floats (use `z.number().int()`).

**Constraints:**
- Use `node:fs/promises` for I/O; do not pull in the sync API except
  inside the atomic-write helper if `renameSync` is needed for ordering.
- Path computation must accept a `home` override so tests run under
  a tmpdir without polluting the real Application Support directory.
- Do not log token values; the only stderr-permissible log is a
  schema-validation failure summary (and even that should redact the
  token strings).
- File mode 0600, parent dir mode 0700 — matches the design doc's
  "0700 on the parent directory" requirement.

## Task 3: `lib/refresh.ts` — `getValidAccessToken()` with module-scope mutex

**Why:** The single chokepoint every proxy call funnels through. The
mutex is the only thing standing between concurrent tool calls and
double-refresh races that burn refresh tokens (since rotation invalidates
the previous refresh token).

This task also lands `lib/cloudBaseUrl.ts` — the env-var-driven URL
helper described in the "Local development testing" section above.
It belongs in this task because `refresh.ts` is the first module to
need a cloud URL; `cloudCall.ts` (Task 4) and `lore_login.ts` (Task 5)
will import the same helper.

**Files:**
- Create: `lore-cowork/server-src/lib/cloudBaseUrl.ts`
- Create: `lore-cowork/server-src/lib/cloudBaseUrl.test.ts`
- Create: `lore-cowork/server-src/lib/refresh.ts`
- Create: `lore-cowork/server-src/lib/refresh.test.ts`

**Contract for `lib/cloudBaseUrl.ts`:**

```ts
/**
 * The base URL for the cloud MCP server and its OAuth endpoints.
 *
 * Read from the `LORE_MCP_BASE_URL` env var at module load. Defaults
 * to the production origin. Trailing slashes are stripped so callers
 * can concatenate `${cloudBaseUrl()}/oauth/token` without doubling.
 *
 * Module-load semantics: the resolved value is cached at import time.
 * Mid-session env mutations are intentionally ignored to keep all
 * cloud calls in a single process pointed at one origin (see plan's
 * Local development testing section).
 */
export function cloudBaseUrl(): string;

/** Test-only: re-read the env var. Tests use this in beforeEach to
 *  flip between prod and localhost without restarting the test process. */
export function __resetCloudBaseUrlForTests(): void;
```

**Acceptance for `cloudBaseUrl.ts`:**
- With no env var set, returns `https://mcp.lore.tanagram.ai`.
- With `LORE_MCP_BASE_URL=http://localhost:4000`, returns
  `http://localhost:4000`.
- With `LORE_MCP_BASE_URL=http://localhost:4000/` (trailing slash),
  returns `http://localhost:4000` (slash stripped).
- Invalid URL in env (e.g. `not-a-url`) → throws at module load with
  a clear message naming the env var. (Fail loud — a misconfigured
  dev env should not silently fall back to prod.)
- Empty-string env var (`LORE_MCP_BASE_URL=`) is treated as unset
  (returns prod default).
- Module-load caching: calling `cloudBaseUrl()` 1000 times after env
  mutation returns the same value as the first call.
- `__resetCloudBaseUrlForTests()` re-reads the env var; subsequent
  calls return the new value.

**Contract:**

```ts
/**
 * Returns a valid access token. Refreshes if `expires_at - now() <= 30_000`.
 * Concurrent callers share a single in-flight refresh promise.
 *
 * Throws `AuthRequiredError` when:
 *   - No tokens file exists.
 *   - The cloud responds `invalid_grant` to the refresh attempt
 *     (in which case this function also deletes the tokens file).
 *
 * Throws other errors verbatim (network errors, 5xx, schema mismatches
 * on the refresh response). Those are not auth-required and the agent
 * should not re-prompt for login.
 */
export function getValidAccessToken(opts?: {
  now?: () => number;
  fetchImpl?: typeof fetch;
  home?: string;
}): Promise<string>;

/** Test-only: reset the module-scope inFlight promise. Tests call this
 *  in `beforeEach` so a failed prior test doesn't leak a rejected
 *  promise into the next. */
export function __resetInFlightForTests(): void;
```

The 30-second skew window is fixed; do not parameterize. The cloud refresh
endpoint is `${cloudBaseUrl()}/oauth/token` with
`grant_type=refresh_token`, `client_id=lore-cowork-plugin`, body as
`application/x-www-form-urlencoded`.

**Acceptance:**
- Fresh access token (`expires_at > now() + 30_000`) → returned without
  any network call.
- Expired access token → POST to `/oauth/token`, write the new pair,
  return the new access token.
- Refresh response missing fields or with invalid `expires_in` →
  re-throws a schema error; tokens file is unchanged.
- Refresh response with `{error: 'invalid_grant'}` → tokens file is
  deleted, `AuthRequiredError` is thrown.
- Refresh response with any other 4xx error → error is thrown verbatim;
  tokens file is **not** deleted (the user shouldn't lose their refresh
  token because the server momentarily 429'd).
- Refresh response with 5xx → error is thrown verbatim; tokens file
  unchanged.
- **Mutex**: 10 concurrent `getValidAccessToken()` calls when tokens are
  expired produce **exactly one** POST to `/oauth/token`. All ten
  promises resolve to the same access token.
- On mutex error path: 10 concurrent calls when the refresh fails with
  `invalid_grant` — all ten reject with `AuthRequiredError`, the
  tokens file is deleted exactly once, and the `inFlight` slot is
  cleared (verified by a subsequent call returning to the no-tokens
  path with no leftover state).
- No tokens file at all → `AuthRequiredError` thrown, no network call
  made.
- New `expires_at` written to disk is computed as
  `now() + expires_in_seconds * 1000`, **not** echoed from the server,
  so clock skew is bounded by the local clock at write time.

**Constraints:**
- The module-scope `inFlight` variable is the contract — do not
  introduce a class instance, a singleton object, or any other
  per-instance state. The mutex semantics are precisely "module
  globals, scoped to the binary process".
- Always clear `inFlight` in a `.finally()`, never only in `.then()` —
  rejection must reset the slot.
- Refresh request body is form-urlencoded, NOT JSON. The cloud
  `handleOAuthToken` parses form bodies via `registerOAuthFormParser`.
- The `fetchImpl` and `now` injection seams exist only for testability;
  production callers pass nothing. Document this on the JSDoc.
- Do not import `lib/cloudCall.ts` — that direction is reversed
  (`cloudCall.ts` imports this module). Mixing them creates a cycle.

## Task 4: `lib/cloudCall.ts` — JSON-RPC proxy with bearer-token attach

**Why:** Each proxy tool would otherwise duplicate envelope construction,
fetch call, and 401-handling. Centralize it so the proxy tools are
30-LOC pass-throughs.

**Files:**
- Create: `lore-cowork/server-src/lib/cloudCall.ts`
- Create: `lore-cowork/server-src/lib/cloudCall.test.ts`

**Contract:**

```ts
/**
 * Call a tool on the cloud `mcp.lore.tanagram.ai/mcp` server with a
 * Bearer JWT obtained from `getValidAccessToken()`.
 *
 * Returns the cloud tool's `result` value verbatim (whatever the
 * JSON-RPC envelope's `.result` field contained).
 *
 * Error behavior:
 *   - Local-side auth failure (no tokens, refresh failed): rethrows
 *     `AuthRequiredError` from `getValidAccessToken`.
 *   - HTTP 401 from the cloud: deletes tokens, throws `AuthRequiredError`.
 *     (Covers server-side revocation between local-expiry check and
 *     request arrival.)
 *   - HTTP non-2xx other: throws `Error` with status + body excerpt.
 *   - JSON-RPC `error` field set: throws `Error` with the error message
 *     (preserves the cloud-side error code in `.cause` if available).
 *   - Malformed JSON / non-JSON body: throws `Error('cloud response was
 *     not valid JSON-RPC')`.
 */
export function callCloudTool<TResult = unknown>(
  toolName: string,
  args: Record<string, unknown>,
  opts?: { fetchImpl?: typeof fetch; home?: string },
): Promise<TResult>;
```

JSON-RPC envelope shape (per MCP spec):
```json
{"jsonrpc": "2.0", "id": <uuid>, "method": "tools/call",
 "params": {"name": "<toolName>", "arguments": <args>}}
```

**Acceptance:**
- Happy path: cloud returns `{jsonrpc, id, result: {...}}` → resolves
  to `result`. Request had `Authorization: Bearer <jwt>` and
  `Content-Type: application/json` headers.
- 401 response → calls `deleteTokens()` exactly once, throws
  `AuthRequiredError`.
- 500 response → throws a non-`AuthRequiredError` Error; tokens file
  is **not** deleted.
- Cloud returns `{jsonrpc, id, error: {code: -32602, message: 'bad input'}}`
  → throws `Error` whose message contains `'bad input'`.
- Cloud returns non-JSON body with 200 status → throws
  `Error('cloud response was not valid JSON-RPC')`.
- Request `id` is unique per call (uuidv4 or crypto.randomUUID).
- `getValidAccessToken` is called exactly once per `callCloudTool` call
  (no double-invocation in the happy path).
- When `getValidAccessToken` throws `AuthRequiredError`, the cloud
  endpoint is never hit (verified by asserting `fetchImpl` was not
  called).

**Constraints:**
- Endpoint URL is `${cloudBaseUrl()}/mcp`. Do not hardcode the prod
  origin — the env-var override is required for local dev (see plan's
  Local development testing section). DESIGN.md's "single hardcoded
  cloud surface" note is superseded by the parallel-cloud-dev reality.
- Import `getValidAccessToken` from `lib/refresh.js`, NOT a re-export
  from `lib/tokens.js`. Same-module imports break the test mocking
  pattern (Bun's module cache is per-importer).
- Header construction must use a plain `Headers` instance or a literal;
  do not `JSON.stringify` headers.
- Do not catch and swallow `AuthRequiredError` here — let it propagate.
  The mapping to MCP error result lives in the per-tool handlers.

## Task 5: `tools/lore_login.ts` — device-flow initiator with browser auto-open

**Why:** Cold-start authentication path. The agent's first proxy call
fails with auth-required, the agent then calls `lore_login`, the user
clicks Allow in the browser, the tool blocks until polling completes
or times out.

**Files:**
- Create: `lore-cowork/server-src/tools/lore_login.ts`
- Create: `lore-cowork/server-src/tools/lore_login.test.ts`

**Contract:**

```ts
import type { ToolDefinition } from '../lib/tool.js';

export const loreLoginTool: ToolDefinition;

/** Pure core for tests. The wrapped `handler` closes over real I/O. */
export function runLoreLogin(opts: {
  fetchImpl: typeof fetch;
  spawnImpl: (cmd: string, args: string[]) => { status: number | null };
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  home: string;
}): Promise<
  | { ok: true }
  | {
      ok: false;
      reason: 'browser_open_failed';
      device_code: string;
      user_code: string;
      verification_uri: string;
      message: string;
    }
  | {
      ok: false;
      reason: 'expired_token';
      message: string;
    }
>;
```

Tool input schema: empty object, `additionalProperties: false`.

Tool description must begin with `"Authenticate to Lore via device flow.
Call this tool when other Lore tools return an auth-required error."`
and mention that a browser tab will open.

Steps:
1. POST `${cloudBaseUrl()}/oauth/device/code` with body
   `client_id=lore-cowork-plugin&scope=mcp.read mcp.write`, form-urlencoded.
2. Parse `{device_code, user_code, verification_uri, verification_uri_complete,
   expires_in, interval}`.
3. Call `spawnImpl('open', [verification_uri_complete])`.
4. If `spawn` exit status !== 0 → return the `browser_open_failed` shape
   with instructions naming `lore_login_resume`.
5. Else poll `${cloudBaseUrl()}/oauth/token` every `interval` seconds with body
   `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=<dc>&client_id=lore-cowork-plugin`,
   form-urlencoded:
   - 200 with token pair → compute `expires_at = now() + expires_in * 1000`,
     `writeTokens(...)`, return `{ok: true}`.
   - 400 with `{error: 'authorization_pending'}` → continue polling.
   - 400 with `{error: 'slow_down'}` → increase local interval by 5s, continue.
   - 400 with `{error: 'expired_token'}` → return the `expired_token`
     shape.
   - Any other error → throw verbatim.
6. Hard cap: stop polling once `now() - start >= expires_in * 1000`;
   return the `expired_token` shape.

**Acceptance:**
- Happy path: device-code returned, browser opens (exit 0), first poll
  returns `authorization_pending`, second poll returns the token pair.
  `writeTokens` was called with `scope: 'mcp.read mcp.write'` and the
  correct `expires_at`. Return value is `{ok: true}`.
- Browser open fails (exit 1): tool returns the `browser_open_failed`
  shape immediately, does NOT poll, does NOT write tokens. Returned
  `message` instructs the user to visit `verification_uri` and call
  `lore_login_resume({device_code})`.
- `slow_down`: after a `slow_down` response, the next poll waits
  `interval + 5` seconds. Subsequent `slow_down` continues to add 5s.
- `expired_token` from server: tool returns the `expired_token` shape;
  no tokens written.
- Hard cap: when the test clock advances past `expires_in * 1000` ms,
  the polling loop exits with the `expired_token` shape even if the
  server hasn't yet returned `expired_token`.
- Unknown cloud error (e.g. `invalid_client`): error propagates verbatim.
- The tool description (visible to the agent) names `lore_login_resume`
  as the headless fallback so the agent can chain correctly.

**Constraints:**
- Use `node:child_process` → `spawnSync` for the `open` call. Inject
  via `spawnImpl` in `runLoreLogin` so tests can stub. The wrapped
  `handler` calls `spawnSync('open', [...], {stdio: 'ignore'})`.
- Polling is sync-blocking from the agent's perspective (the JSON-RPC
  call doesn't return until the loop completes). This is intentional —
  Cowork does not support streaming partial tool results.
- The device_code must NEVER appear in the tool's return value on
  success (it's a credential). On `browser_open_failed`, returning it
  is necessary so the user can paste it into `lore_login_resume`.
- The `user_code` may appear in the `browser_open_failed` response so
  the user can visually compare against the consent screen.
- Do not log any of `device_code`, `access_token`, or `refresh_token`
  to stderr (stdout is reserved for JSON-RPC framing).

## Task 6: `tools/lore_login_resume.ts` — headless fallback polling

**Why:** Symmetric to Task 5 for sessions where `open` failed (SSH,
no DISPLAY, sandboxed). The user visits the URL from another device;
the agent polls with the device_code that was surfaced earlier.

**Files:**
- Create: `lore-cowork/server-src/tools/lore_login_resume.ts`
- Create: `lore-cowork/server-src/tools/lore_login_resume.test.ts`

**Contract:**

```ts
export const loreLoginResumeTool: ToolDefinition;

export function runLoreLoginResume(opts: {
  device_code: string;
  expires_in_seconds?: number;  // defaults to 600
  interval_seconds?: number;    // defaults to 5
  fetchImpl: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  home: string;
}): Promise<
  | { ok: true }
  | { ok: false; reason: 'expired_token'; message: string }
>;
```

Tool input schema:
```ts
{
  type: 'object',
  properties: { device_code: { type: 'string' } },
  required: ['device_code'],
  additionalProperties: false,
}
```

Tool description: `"Resume a previously-started Lore login when browser
auto-open failed. Pass the device_code returned by lore_login. Polls
until you approve in your browser or the code expires."`

Polling logic is identical to Task 5 step 5–6.

**Acceptance:**
- All acceptance items from Task 5 polling block apply here.
- Missing/empty `device_code` argument is rejected by the dispatcher's
  schema validator (no per-tool check needed — `index.ts:validateAgainstSchema`
  handles `required` and `type: string`).
- The tool runs even when no `lore_login` call preceded it in the
  same process — there is no module-scope state shared between the two
  tools. The `device_code` arg is the only state.

**Constraints:**
- Do not import from `tools/lore_login.ts`. Share polling logic by
  extracting a private helper into `tools/lore_login.ts`'s file
  (exported as `pollDeviceToken`) and importing here. Keeps the
  call graph shallow.
- Defaults for `expires_in_seconds` and `interval_seconds` exist
  because the server doesn't re-issue them on resume — the agent
  doesn't have to round-trip them through the conversation.

## Tasks 7a–7d (parallel): proxy tools for cloud MCP

> These four tasks are independent and can be executed in parallel.
> All depend on: Task 1 (errors), Task 3 (refresh), Task 4 (cloudCall).

Each tool is a thin wrapper around `callCloudTool`. The `share_session`
tool must always pass `harness: 'cowork'` per the existing
[lore-cowork/commands/share.md](lore-cowork/commands/share.md) contract
(lore PR #484); it merges that with the agent-supplied args.

### Task 7a: `tools/share_session.ts`

**Files:**
- Create: `lore-cowork/server-src/tools/share_session.ts`
- Create: `lore-cowork/server-src/tools/share_session.test.ts`

**Contract:**

```ts
export const shareSessionTool: ToolDefinition;
```

Input schema:
```ts
{
  type: 'object',
  properties: {
    transcript: { type: 'string' },
  },
  required: ['transcript'],
  additionalProperties: false,
}
```

Description (visible to agent):
`"Share the current session to Lore. Requires authentication via
lore_login on first use. Returns {thread_id, thread_url}. Always called
with harness 'cowork' on this plugin (set automatically)."`

Handler behavior:
- Call `callCloudTool('share_session', {...args, harness: 'cowork'})`.
- `AuthRequiredError` → return `authRequiredToMcpError()`.
- Any other error → re-throw (the dispatcher will surface it as an
  MCP error to the agent).

**Acceptance:**
- Happy path: cloud returns `{thread_id, thread_url}`; the tool returns
  that object verbatim. Request body sent to cloud included
  `harness: 'cowork'`.
- The handler MERGES `harness: 'cowork'` even when the agent passes
  `harness: 'something_else'` — the local value wins. Add this as a
  separate test case to lock the contract.
- No tokens on disk → returns `{isError: true, content: [{type: 'text',
  text: AUTH_REQUIRED_MESSAGE}]}`.
- Cloud returns 401 → same auth-required result, tokens deleted.
- Cloud returns `{error: 'workspace_required'}` → re-thrown as a
  non-auth error (dispatcher surfaces to agent).
- The literal substring `harness` does not appear in the input schema
  `properties` — the agent must not be able to override it via the
  schema layer.

### Task 7b: `tools/get_thread.ts`

**Files:**
- Create: `lore-cowork/server-src/tools/get_thread.ts`
- Create: `lore-cowork/server-src/tools/get_thread.test.ts`

**Contract:**

```ts
export const getThreadTool: ToolDefinition;
```

Input schema:
```ts
{
  type: 'object',
  properties: {
    thread_id: { type: 'string' },
  },
  required: ['thread_id'],
  additionalProperties: false,
}
```

Description: `"Fetch a Lore thread by id. Requires authentication via
lore_login on first use."`

Handler: passes args to `callCloudTool('get_thread', args)`. Same
`AuthRequiredError` → `authRequiredToMcpError()` mapping.

**Acceptance:**
- Happy path round-trips cloud result verbatim.
- Auth-required and 401 cases match Task 7a contracts.

### Task 7c: `tools/list_threads.ts`

**Files:**
- Create: `lore-cowork/server-src/tools/list_threads.ts`
- Create: `lore-cowork/server-src/tools/list_threads.test.ts`

**Contract:**

```ts
export const listThreadsTool: ToolDefinition;
```

Input schema:
```ts
{
  type: 'object',
  properties: {
    limit: { type: 'integer' },
    cursor: { type: 'string' },
  },
  additionalProperties: false,
}
```

Description: `"List recent Lore threads in your workspaces. Requires
authentication via lore_login on first use."`

**Acceptance:**
- Happy path round-trips cloud result.
- Both args optional — call with empty args object succeeds.
- `limit` accepts integers; floats rejected by the dispatcher's schema
  validator (existing `'integer'` branch in `index.ts:validateAgainstSchema`).
- Auth-required and 401 cases match Task 7a.

### Task 7d: `tools/search_threads.ts`

**Files:**
- Create: `lore-cowork/server-src/tools/search_threads.ts`
- Create: `lore-cowork/server-src/tools/search_threads.test.ts`

**Contract:**

```ts
export const searchThreadsTool: ToolDefinition;
```

Input schema:
```ts
{
  type: 'object',
  properties: {
    query: { type: 'string' },
    limit: { type: 'integer' },
  },
  required: ['query'],
  additionalProperties: false,
}
```

Description: `"Search Lore threads by title across your workspaces.
Requires authentication via lore_login on first use."`

**Acceptance:**
- Happy path round-trips cloud result.
- Missing `query` rejected by dispatcher (existing `required` enforcement).
- Auth-required and 401 cases match Task 7a.

## Task 8: Tool barrel — register all six new tools

**Why:** The SDK dispatcher reads `tools/index.ts`. Without this edit
the new tools are dead code in the binary.

**Files:**
- Modify: `lore-cowork/server-src/tools/index.ts`
- Create: `lore-cowork/server-src/tools/index.test.ts` (extends the
  existing pattern in `server-src/index.test.ts` — or, if that file
  already covers barrel contents, append the new tool-name assertions
  there instead of creating a new test file).

**Contract:**

```ts
import { listLocalSessionsTool } from './listLocalSessions.js';
import { readLocalSessionTool } from './readLocalSession.js';
import { loreLoginTool } from './lore_login.js';
import { loreLoginResumeTool } from './lore_login_resume.js';
import { shareSessionTool } from './share_session.js';
import { getThreadTool } from './get_thread.js';
import { listThreadsTool } from './list_threads.js';
import { searchThreadsTool } from './search_threads.js';

export const tools: ToolDefinition[] = [
  listLocalSessionsTool,
  readLocalSessionTool,
  loreLoginTool,
  loreLoginResumeTool,
  shareSessionTool,
  getThreadTool,
  listThreadsTool,
  searchThreadsTool,
];
```

The export order matters for the `tools/list` MCP response — local
tools first (existing UX), then auth, then proxies, mirroring the
agent's expected call order.

**Acceptance:**
- `tools/list` MCP request returns 8 tools in the order above.
- Each tool's `name`, `description`, and `inputSchema` are present.
- No tool name appears twice.

**Constraints:**
- Use `.js` extensions on all imports (existing convention for the
  TS-to-Bun compile).
- Do not re-export tool internals — only the `ToolDefinition` entries.

## Task 9: `.mcp.json` — drop remote lore entry; keep stdio entry only

**Why:** With the proxy tools live, the agent should see one MCP
server only. Leaving the remote `lore` entry causes Cowork to retry
the broken OAuth flow on every session start and creates tool-name
collisions (`share_session` exists in both).

**Files:**
- Modify: `lore-cowork/.mcp.json`

**Contract:**

```json
{
  "mcpServers": {
    "lore-cowork-local": {
      "command": "${CLAUDE_PLUGIN_ROOT}/server/lore-cowork-mcp",
      "type": "stdio"
    }
  }
}
```

Note `"type": "stdio"` (not `"transport": "stdio"`) — the prior
diagnostic session established that the current Cowork plugin schema
uses `type`. The stale uncommitted change in the main worktree had
this fix; folding it in here.

**Acceptance:**
- File contains exactly one server entry: `lore-cowork-local`.
- No `lore` key present.
- `"type": "stdio"` not `"transport": "stdio"` (already true post-merge).
- JSON is valid; `jq .` parses without error.

**Constraints:**
- Do not change the `${CLAUDE_PLUGIN_ROOT}` template — it's the documented
  plugin path variable.
- This file ships as-is to the user's `~/.claude/plugins/...` directory
  via `/plugin install`; no env-var interpolation occurs at our side.
- Latest main already fixed the schema keys (`transport` → `type`,
  `streamable-http` → `http`) and updated the URL to
  `https://mcp.lore.tanagram.ai/mcp` in commit c4f8358. This task is
  now solely about removing the `lore` server entry.

## Task 10: Slash command updates — route through `lore-cowork-local`

**Why:** The existing slash commands tell the agent to call
`lore.share_session`, `lore.get_thread`, etc. With the remote `lore`
server gone, those tool names don't exist. Update the prose to name
the local server and the proxy tool names, and to mention `lore_login`
as the auth bootstrap.

**Files:**
- Modify: `lore-cowork/commands/share.md`
- Modify: `lore-cowork/commands/lore.md`

**Contract for `share.md`:**

The Steps section becomes:

1. Call `lore-cowork-local.read_local_session` with no arguments.
   [unchanged content from existing file]
2. [Unchanged: list_local_sessions fallback for older sessions.]
3. Call `lore-cowork-local.share_session({ transcript })`. The plugin
   adds `harness: 'cowork'` automatically — do NOT pass it. Do NOT pass
   `workspace_id`. If the call returns the `AUTH_REQUIRED_MESSAGE`
   error, call `lore-cowork-local.lore_login` (no args), then retry
   step 3 once. If `lore_login` returns `{ok: false, reason:
   'browser_open_failed', ...}`, surface the `verification_uri` and
   `user_code` to the user and tell them to either visit the URL on
   another device and call `lore-cowork-local.lore_login_resume({device_code})`,
   or open it themselves and call `lore_login_resume` once they've
   approved.
4. [Unchanged: render thread_url + artifact mentions.]

The Failure modes block: replace "Auth errors → Cowork will re-prompt
for consent" with "Auth-required errors → call `lore_login` and retry."

**Contract for `lore.md`:**

Replace every reference to "the `lore` MCP server" with "the
`lore-cowork-local` MCP server". Tool names (`get_thread`,
`search_threads`, `list_threads`) stay the same — only the server
prefix changes.

Add a section at the bottom:

```
First-use auth: If any read tool returns an `AUTH_REQUIRED_MESSAGE`
error, call `lore-cowork-local.lore_login` first, then retry. Same
browser-open-failed fallback as the share flow.
```

**Acceptance:**
- Neither file mentions `lore.share_session`, `lore.get_thread`,
  `lore.list_threads`, or `lore.search_threads` (i.e. the remote
  server prefix is gone).
- Both files mention `lore_login` as the auth bootstrap.
- The `share.md` `harness` instruction switches from "must pass
  `harness: 'cowork'`" to "the plugin adds it automatically — do NOT
  pass it".
- Both files remain LLM-directed prose, not user-facing copy
  (existing convention).
- `description:` frontmatter in both files is unchanged.

**Constraints:**
- These files are the agent's primary tool-selection guide. Keep the
  tone consistent with the existing prose (no "AI slop" formatting).
- Do not say "transcript", "JSONL", or "MCP" in any user-visible
  string the agent will produce — the slash-command rules already
  enforce this and the existing prose lists those forbidden words.

## Task 11: Rebuild Bun binary; verify CI drift check passes

**Why:** The committed binary at `lore-cowork/server/lore-cowork-mcp`
must match `lore-cowork/server-src/` per the CI drift workflow
established in commit 1beed93 ("Add CI workflow to guard against
lore-cowork binary drift"). Without a rebuild, every PR after this
work fails CI.

**Files:**
- Modify: `lore-cowork/server/lore-cowork-mcp` (the compiled binary)

**Contract:**

Run `bash lore-cowork/scripts/build.sh` from any cwd. The script's
own conventions (cd to `lore-cowork/`, build with
`--target=bun-darwin-arm64`, write to `server/lore-cowork-mcp`) are
already correct.

**Acceptance:**
- After build, `git status` shows `lore-cowork/server/lore-cowork-mcp`
  as the only binary delta.
- Binary executes: spawning it with stdio and sending an MCP
  `initialize` request returns a valid `InitializeResult` with
  `tools` capability declared.
- `tools/list` against the running binary returns all 8 tool names.
- CI drift workflow (re-run script in CI, diff against committed
  binary) reports no drift.

**Constraints:**
- Build target stays `bun-darwin-arm64` — DESIGN.md commits to mac-arm64
  only for v0.1.0.
- Commit the rebuilt binary in the same commit as the source changes
  (or as the last commit of a stacked series — both are acceptable;
  the drift check only runs on PR HEAD).
- The build script has no flags to change; do not modify
  `scripts/build.sh` as part of this work.

## Task 12: End-to-end integration test against local lore dev stack

**Why:** Unit tests mock the cloud. Final validation requires the real
endpoints (`POST /oauth/device/code`, modified `/oauth/token`, `/oauth/device`
consent page). Per `tanagram/lore:CONTRIBUTING.md`, the lore dev stack
runs locally via `pnpm dev` on `http://localhost:4000`. This task runs
the E2E test against that local stack with
`LORE_MCP_BASE_URL=http://localhost:4000` set in the binary's env.

Cloud-side endpoints ship in parallel; this task is **runnable as soon
as the cloud-side branch is merged or available in a local checkout
at `/Users/quentindonnelly/repos/lore`** — no production deploy
required.

**Files:**
- Create: `lore-cowork/server-src/__e2e__/device_flow.e2e.test.ts`
  (excluded from default `bun test` via filename pattern; run with
  `bun test --pattern '__e2e__'` explicitly)

**Contract:**

A single end-to-end test, run with `LORE_MCP_BASE_URL=http://localhost:4000`
set in the binary's env:
1. Spawns the compiled binary.
2. Sends `tools/call` for `lore_login` (no args).
3. Captures the `verification_uri_complete` from a `browser_open_failed`
   result (the test mocks `spawnSync('open')` to return exit 1, since
   the test runner has no browser).
4. Performs the browser approval out-of-band: the test holds a
   dev-environment session cookie (sourced from `process.env.LORE_TEST_SESSION_COOKIE`)
   and POSTs the consent form directly to `http://localhost:4000/oauth/device`
   with that cookie attached.
5. Calls `lore_login_resume({device_code})`.
6. Asserts `{ok: true}`.
7. Calls `share_session({transcript: '...'})` and asserts a `thread_id`
   comes back.
8. Restarts the binary; calls `share_session` again. Asserts success
   (warm-start path).
9. Sets `expires_at` to `now() - 60_000` in the tokens file by hand;
   calls `share_session`. Asserts success (refresh-with-rotation path).
10. Revokes the access token via a test-only endpoint or by manually
    setting the refresh row's `revoked_at` in the dev DB; calls
    `share_session`; asserts `AUTH_REQUIRED_MESSAGE` content.

The test takes ~30s and requires `pnpm dev` running in
`/Users/quentindonnelly/repos/lore`, plus `LORE_TEST_SESSION_COOKIE`
and (for step 10) DB access via the shared Railway dev tier. It is
skipped when `LORE_MCP_BASE_URL` is unset or `LORE_TEST_SESSION_COOKIE`
is absent.

**Acceptance:**
- All 10 steps pass against a staging deployment of the cloud plan.
- The test is excluded from the default `bun test` run (so PRs without
  cloud access don't get blocked).
- A README note in `lore-cowork/README.md` documents how to run the
  E2E test locally with the required env vars.

**Constraints:**
- Do not commit `LORE_TEST_SESSION_COOKIE` or any real JWTs.
- This task DOES NOT block the rest of the plan from merging. If the
  cloud-side branch isn't ready locally, mark Task 12 as `skip` and
  proceed with Tasks 1–11 behind the existing per-PR review process.
- Do not modify production DB rows. The test operates against the
  shared Railway dev tier only (`pnpm dev`).
- Test must not assume any particular `LORE_MCP_BASE_URL` value — read
  it via `cloudBaseUrl()` so the same test would work against a staging
  prod URL if anyone runs it that way.

## Test plan summary (from design doc, ~500 LOC total)

Per design doc:

- `tokens.test.ts` — atomic write, perms, Zod validation, concurrent
  reads. **Task 2.**
- `refresh.test.ts` — fresh-skip, expired-refresh, invalid_grant-delete,
  mutex collapses 10 concurrent refresh calls to one network hit,
  error clears inFlight. **Task 3.**
- `cloudCall.test.ts` — happy path, 401-deletes-tokens, 5xx-surfaces,
  malformed-rpc. **Task 4.**
- `lore_login.test.ts` — happy path, browser-open failure → resume hint,
  expired_token, slow_down doubles interval. **Task 5.**
- `lore_login_resume.test.ts` — symmetric. **Task 6.**
- Each proxy tool: happy path, auth_required-on-no-tokens,
  auth_required-on-401. **Tasks 7a–7d.**
- `errors.test.ts` — `AuthRequiredError` instanceof + MCP-shape mapping.
  **Task 1.**

All unit tests run under `bun test` with no network access. The shared
`lib/__testhelpers__/cloudMock.ts` helper from the Rationale section
provides a fetch stub for `/oauth/device/code`, `/oauth/token`, and
`/mcp` — written once in Task 3 (the first task that needs cloud-call
mocks) and extended in Tasks 4, 5, 7.

## Out-of-scope reminders (from design doc, do not implement)

- Keychain-based token storage (file with 0600 is sufficient).
- Cross-platform binaries (mac-arm64 only).
- Multi-window file-lock (module-scope mutex covers single-process
  concurrency).
- Workspace selection on share (always private visibility).
- WorkOS-token bridging.
- Inngest cleanup of `oauth_device_codes`.

## Execution Handoff

Plan saved to
[docs/plans/2026-05-15-lore-cowork-device-flow-auth-plugin.md](docs/plans/2026-05-15-lore-cowork-device-flow-auth-plugin.md).
Two execution options:

**1. Subagent-Driven (this session)** — Fresh subagent per task, review
between tasks, fast iteration.

**2. Parallel Session (separate)** — Open new session in this worktree,
batch execution with checkpoints.

Which approach?
