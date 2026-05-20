# Lore plugin — design

A sibling of `lore-plugin/lore/` for **Claude Cowork**. Gives Cowork users the same two affordances the existing Claude Code plugin gives developers — post the current session to Lore, and read Lore threads back — adapted to Cowork's sandboxed agent environment.

The plugin ships a thin **host-side MCP server** that exposes the user's local Cowork session bytes to the agent, and also proxies the cloud Lore tools (`share_session`, `get_thread`, `list_threads`, `search_threads`) through the same stdio server. The cloud is OAuth-protected via WorkOS AuthKit (RFC 8628 device-code flow); the host MCP server drives that flow in-process via the `lib/auth/` library and persists tokens locally.

## Why the split

Three properties of Cowork force the architecture:

1. The agent's sandbox cannot read `~/Library/Application Support/Claude/local-agent-mode-sessions/`. The only path from the agent to its own `audit.jsonl` bytes is a plugin-bundled MCP server running on the user's Mac.
2. The cloud Lore MCP at `https://lore.tanagram.ai/mcp` already implements `share_session`, `get_thread`, `list_threads`, `search_threads`. Reimplementing them in the host would duplicate auth, upload, and visibility logic. We want the host to do *only* what it uniquely can.
3. The cloud is fronted by WorkOS AuthKit. The plugin authenticates as a public OAuth client (RFC 8252) using the RFC 8628 device-authorization flow, discovers endpoints via PRM → AS metadata (RFC 8414 / RFC 8707), and manages tokens entirely in-process.

So the host MCP server does two jobs: read the local session bytes, and proxy authenticated calls to the cloud Lore tools.

## User experience

**Share.** User says "share this", "post this to Lore", "send this to my team". The agent calls the host tool `read_local_session` (no args) to get the transcript, then calls the cloud tool `share_session({ transcript })`. The cloud returns a `thread_url`, which the agent surfaces to the user as a clickable link along with a brief note about any artifacts found (e.g. "Included files from your session: `plan.md`, `summary.md`."). If the user explicitly asks to share an older session ("share the one from yesterday"), the agent calls `list_local_sessions` first to browse.

**Read.** User says "show me that Lore thread `th_...`", "find threads about onboarding", or "list recent Lore threads". The agent calls one of `get_thread` / `search_threads` / `list_threads` directly on the cloud MCP. No host involvement.

**Auth.** When a cloud-proxy tool runs without valid tokens (or the cloud returns 401), the agent calls the plugin's `lore_login` tool, which mints a device code, opens the WorkOS AuthKit consent screen with the code pre-filled, and polls until the user approves. Tokens land at `~/Library/Application Support/tanagram/lore/tokens.json` (mode 0600). Subsequent cloud calls are zero-friction — `getValidAccessToken` refreshes silently when the access token has under 30s of life left, deduping concurrent refreshes via an in-flight mutex. If `spawn('open')` fails (SSH, no GUI), `lore_login` returns a `verification_uri` + `device_code` and the agent calls `lore_login_resume` once the user has completed the flow on another device.

User-visible strings are plain language. The agent should never surface "transcript", "JSONL", "presigned PUT", "MCP", or other implementation language.

## Architecture

```
lore-plugin/
├── .claude-plugin/marketplace.json     # lists both plugins
├── lore/                               # existing Claude Code plugin
│   ├── .claude-plugin/plugin.json
│   └── commands/{share,lore}.md
└── lore/                        # NEW
    ├── .claude-plugin/plugin.json
    ├── .mcp.json                       # registers host + cloud servers
    ├── commands/{share,lore}.md
    ├── server/lore-mcp          # committed Bun-compiled binary
    ├── server-src/                     # TS source for the binary
    │   ├── index.ts
    │   ├── tools/{listLocalSessions,readLocalSession}.ts
    │   └── lib/session.ts              # ported from lore monorepo
    ├── scripts/build.sh
    ├── package.json                    # dev deps only
    └── README.md
```

### `.mcp.json`

```json
{
  "mcpServers": {
    "lore-local": {
      "type": "stdio",
      "command": "${CLAUDE_PLUGIN_ROOT}/server/lore-mcp"
    }
  }
}
```

Only one MCP server is registered: the bundled stdio binary. It exposes both the local session tools (`list_local_sessions`, `read_local_session`) and the cloud-proxy tools (`share_session`, `get_thread`, `list_threads`, `search_threads`, `lore_login`, `lore_login_resume`). The proxy tools POST JSON-RPC envelopes to `https://lore.tanagram.ai/mcp` from inside the stdio process; the agent only sees a single MCP server.

### Host MCP server

**Runtime.** TypeScript source under `server-src/`, compiled via `bun build --compile --target=bun-darwin-arm64 server-src/index.ts --outfile server/lore-mcp`. Produces a single ~50MB binary with no runtime dependencies — works for non-developer Cowork users without a Node-on-PATH requirement. Committed to the repo so `/plugin install` ships it directly. Mac-arm64 only for v1, matching Cowork's ship surface and the existing CLI's `defaultSessionsRoot()` mac-only path.

**Transport.** Stdio per the MCP SDK. Cowork starts the process via `.mcp.json`, communicates over stdin/stdout, kills it when done. JSON-RPC framing, no socket, no port.

**Tool 1: `list_local_sessions`**

```ts
inputSchema: { type: 'object', properties: {}, additionalProperties: false }
// returns:
{
  sessions: [{ session_id: string, conversation_id: string, mtime_ms: number }]
}
```

Enumerates every session under `~/Library/Application Support/Claude/local-agent-mode-sessions/<conv>/<sess>/`, sorted newest-mtime first. Empty array when the root doesn't exist. Used only when the agent needs to browse older sessions; the default share flow does not call it.

**Tool 2: `read_local_session`**

```ts
inputSchema: {
  type: 'object',
  properties: { session_id: { type: 'string' } },
  additionalProperties: false
}
// returns:
{
  session_id: string,
  conversation_id: string,
  transcript: string,    // UTF-8 contents of audit.jsonl
  uploads: string[],     // basenames only
  outputs: string[]      // basenames only
}
```

**Session resolution priority**:
1. Explicit `session_id` argument
2. `COWORK_SESSION_ID` env var set by Cowork at server launch
3. Newest-mtime session under the sessions root

**Transcript discovery**: walks into the session's `local_*` subdir and reads `audit.jsonl` (fallback to `transcript.jsonl`). Returns the bytes as a UTF-8 string. `uploads` and `outputs` are basenames from the corresponding subdirs.

**Error mapping**:
- No session found → `McpError(InvalidParams, "no Cowork session found")`
- Explicit `session_id` doesn't exist → `McpError(InvalidParams, "session not found: <id>")`
- Filesystem error → `McpError(InternalError, <sanitized message>)`

**Code reuse.** For v1, port `apps/cli/src/upload/cowork/resolveSession.ts` and `readSession.ts` from the lore monorepo into `server-src/lib/session.ts` verbatim (~150 LOC). v2: extract to a shared `@tanagram/cowork-session` npm package consumed by both this plugin and the CLI.

### Cloud MCP

Proxied through the host stdio server. The plugin's `share_session`, `get_thread`, `list_threads`, and `search_threads` tools each call `callCloudTool` in `lib/cloudCall.ts`, which acquires a bearer token via `getValidAccessToken` and POSTs a JSON-RPC envelope to `${cloudBaseUrl()}/mcp`.

Auth is handled entirely in-process by the `lib/auth/` library:

1. **Discovery** (`lib/auth/discovery.ts`). On first use, `GET ${cloudBaseUrl()}/.well-known/oauth-protected-resource` (PRM) yields `resource` (the eventual access-token audience) and `authorization_servers[0]`. A follow-up `GET ${as}/.well-known/oauth-authorization-server` (RFC 8414) yields `issuer` and `token_endpoint`. `deviceAuthorizationEndpoint` is derived as `${issuer}/oauth2/device_authorization` (WorkOS convention; not advertised in AS metadata). Results are cached at `~/Library/Application Support/tanagram/lore/discovery-cache.json` with a 24h TTL and ETag revalidation.
2. **Cold-start login** (`tools/lore_login.ts` → `lib/auth/deviceFlow.ts`). RFC 8628 device-code flow against AuthKit. Public WorkOS Connect client `client_01KRSDB9SR20N7MB0D9MPS05Q6` is configured for CLI Auth / device authorization and is safe to commit because public OAuth clients are not credentials (RFC 8252 §8.4). Requests OIDC scopes `openid email profile offline_access` and passes the discovered PRM value as WorkOS's RFC 8707 `resource` form parameter. Polls the token endpoint at the server-supplied interval, honors `slow_down` per RFC 8628 §3.5, and enforces a local hard cap on the device-code lifetime.
3. **Headless fallback** (`tools/lore_login_resume.ts`). If `spawn('open')` fails, `lore_login` returns the `device_code` + `verification_uri`; the agent then calls `lore_login_resume` to drive the poll loop from a headless context.
4. **Token storage** (`lib/auth/store.ts`). `tokens.json` at `~/Library/Application Support/tanagram/lore/tokens.json` (file 0600, parent dir 0700, atomic temp+rename writes). Stores `{ access_token, refresh_token, expires_at, scope }` — `expires_at` is computed from the local clock at write time.
5. **Silent refresh** (`lib/auth/refresh.ts`). `getValidAccessToken` returns the cached access token when it has ≥30s left; otherwise POSTs the refresh-token grant to the discovered token endpoint, persists the rotated pair, and returns the new access token. Concurrent callers share one in-flight refresh via a module-scope mutex.
6. **401 handling** (`lib/cloudCall.ts`). A 401 from the cloud means the refresh token has been revoked server-side. The cloud-call helper wipes `tokens.json` and throws `AuthRequiredError`; the per-tool dispatcher maps that to a `CallToolResult` whose message names `lore_login`, prompting the agent to re-authenticate.

Tools available via the host proxy (cloud-side implementations live in lore PR #458 / PR #484):

| Tool | Purpose |
|------|---------|
| `share_session` | Persist transcript as a Lore thread, return `thread_id` + `thread_url` |
| `get_thread` | Fetch a single thread by id |
| `list_threads` | Paginated list across the caller's workspaces |
| `search_threads` | Title search across the caller's workspaces |

**`harness` is required on `share_session`.** Per [lore PR #484](https://github.com/tanagram/lore/pull/484), the tool now demands an explicit `harness` value validated against the enum (`claudeCode`, `codex`, `amp`, `cursor`, `cowork`, `unspecified`). This plugin always passes `harness: 'cowork'` so per-harness analytics and the `cliStatusResponse.connected` signal stay correctly attributed. The slash command body must spell this out so the agent never omits it.

**Visibility default.** The agent always omits `workspace_id` when calling `share_session`. The cloud forces `visibility='private'` in that case — that's the v1 default. To share workspace-visible, the user re-shares from the Lore web UI. Future: add a `list_workspaces` tool to the cloud MCP and let the agent ask the user which workspace to share to. Out of scope for this plugin.

## Slash commands

Both files are short LLM-directed prose. Cowork surfaces MCP tool descriptions to the agent on every turn, so the slash commands carry only the tone, tool-selection rules, and failure UX — they do not repeat schemas.

### `commands/share.md`

```markdown
---
description: Share the current Cowork session to Lore. Returns a shareable URL.
---

Share the user's current Cowork session to Lore. Steps:

1. Call the `lore-local` MCP tool `read_local_session` with no arguments. The server resolves the current session from `COWORK_SESSION_ID` or the most-recently-modified session on disk. Returns `{ session_id, conversation_id, transcript, uploads, outputs }`.

2. If the user asked to share a *specific* older session ("share the one from yesterday", "share session abc-123"), call `list_local_sessions` first, pick the matching entry, then call `read_local_session({ session_id })`.

3. Call the `lore` MCP tool `share_session({ transcript, harness: 'cowork' })`. The `harness` value is required (per lore PR #484) and must be the literal string `'cowork'` for this plugin. Do NOT pass `workspace_id` — the cloud forces private visibility and that's the v1 default. Returns `{ thread_id, thread_url }`.

4. Respond in plain language. Surface `thread_url` as a clickable link. If `uploads` or `outputs` were non-empty, mention them briefly. Do not say "transcript", "JSONL", or "MCP".

Failure modes:
- `read_local_session` errors with "no Cowork session found" → ask the user if they want to share an older one (then list).
- `share_session` errors → surface the message, suggest retry. Auth errors carry the `lore_login` cue in the error message — call that tool to re-authenticate.
- Empty transcript → tell the user the session has no content yet.
```

### `commands/lore.md`

```markdown
---
description: Read from Lore — fetch a thread by ID/URL or list/search threads.
---

Pick the right `lore` MCP tool based on `$ARGUMENTS`:

- Thread ID (`th_...`) or Lore URL → `get_thread({ thread_id })`. Extract id from URL path.
- Keyword phrase → `search_threads({ query: $ARGUMENTS, limit: 10 })`.
- "recent", "latest", or empty → `list_threads({ limit: 10 })`.

Render in plain language. Single-thread fetches: surface URL prominently with title and author. Lists: top matches as one-liners. Mention pagination cursors only if useful. Empty results: suggest loosening the query.

Do not say "transcript", "JSONL", or "MCP" in user-facing text. Auth errors carry the `lore_login` cue in the error message — call that tool to re-authenticate.
```

## Build, marketplace, and versioning

**Build script** (`scripts/build.sh`):

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun build --compile --target=bun-darwin-arm64 server-src/index.ts --outfile server/lore-mcp
```

**CI** verifies the committed binary matches `server-src/`. On PRs that touch `lore/server-src/**`, a GitHub Actions job runs `scripts/build.sh` and diffs against `server/lore-mcp`. Drift fails the PR — the contributor must rebuild and re-commit.

**Marketplace entry** in `.claude-plugin/marketplace.json`:

```json
{
  "name": "lore",
  "source": "./lore",
  "description": "Share your Cowork session to Lore and read threads back.",
  "homepage": "https://lore.tanagram.ai",
  "license": "MIT",
  "category": "collaboration",
  "keywords": ["lore", "tanagram", "cowork", "share", "threads"]
}
```

**Plugin manifest** at `lore/.claude-plugin/plugin.json` mirrors the existing `lore/` plugin: `name: "lore"`, `version: "0.1.0"`, same author and license blocks.

## Pre-ship verification list

Open assumptions to validate before tagging v0.1.0:

1. Cowork supports `"transport": "streamable-http"` MCP servers in plugin `.mcp.json`. **(User confirmed Cowork supports both `http` and `streamable-http`.)**
2. The in-process AuthKit device-code flow can drive `spawn('open', [...])` from within the stdio MCP server's process tree on a typical Cowork host. (Fallback: `lore_login_resume` covers the SSH / no-GUI case.)
3. Cowork sets a `COWORK_SESSION_ID` env var when launching plugin stdio MCP servers. If not present, host falls back to newest-mtime — verify the fallback is acceptable UX.
4. Cowork executes committed binaries from `${CLAUDE_PLUGIN_ROOT}/server/`. Verify path templating works and the binary executes (no Gatekeeper or quarantine blocks for plugin-shipped binaries).
5. Realistic `audit.jsonl` size doesn't blow the agent's context budget on share. Spot-check with a representative session.

## Out of scope for v1

- mac-x86_64 and linux binaries (matrix build + release artifacts)
- `list_workspaces` cloud MCP tool for workspace-visible share-by-default
- Attaching upload/output file bytes to the Lore thread (today: filenames only)
- Semantic search across thread bodies (today: title search only)
- Skill registration — Cowork plugins surface MCP tool descriptions to the agent on every turn; that's the right place for trigger phrases
