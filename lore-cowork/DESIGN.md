# Lore Cowork plugin — design

A sibling of `lore-plugin/lore/` for **Claude Cowork**. Gives Cowork users the same two affordances the existing Claude Code plugin gives developers — post the current session to Lore, and read Lore threads back — adapted to Cowork's sandboxed agent environment.

The plugin ships a thin **host-side MCP server** that exposes the user's local Cowork session bytes to the agent, and registers the existing **cloud Lore MCP server** as a remote MCP source. The cloud MCP (shipped in lore PRs #456 / #458 / #461) is OAuth-protected; Cowork drives the OAuth flow client-side, so this plugin does not handle auth at all.

## Why the split

Three properties of Cowork force the architecture:

1. The agent's sandbox cannot read `~/Library/Application Support/Claude/local-agent-mode-sessions/`. The only path from the agent to its own `audit.jsonl` bytes is a plugin-bundled MCP server running on the user's Mac.
2. The cloud Lore MCP at `https://lore.tanagram.ai/mcp` already implements `share_session`, `get_thread`, `list_threads`, `search_threads`. Reimplementing them in the host would duplicate auth, upload, and visibility logic. We want the host to do *only* what it uniquely can.
3. The cloud MCP is a full OAuth 2.1 Authorization Server (RFC 8414 discovery, RFC 7591 dynamic client registration, PKCE-S256, refresh token rotation). Any MCP client that speaks the standard OAuth flow — including Cowork — handles auth without plugin involvement.

So the host MCP server is reduced to a "local session reader". The cloud MCP does everything else.

## User experience

**Share.** User says "share this", "post this to Lore", "send this to my team". The agent calls the host tool `read_local_session` (no args) to get the transcript, then calls the cloud tool `share_session({ transcript })`. The cloud returns a `thread_url`, which the agent surfaces to the user as a clickable link along with a brief note about any artifacts found (e.g. "Included files from your session: `plan.md`, `summary.md`."). If the user explicitly asks to share an older session ("share the one from yesterday"), the agent calls `list_local_sessions` first to browse.

**Read.** User says "show me that Lore thread `th_...`", "find threads about onboarding", or "list recent Lore threads". The agent calls one of `get_thread` / `search_threads` / `list_threads` directly on the cloud MCP. No host involvement.

**Auth.** On first tool call to the cloud MCP, Cowork pops a browser to the Lore consent screen. User signs in via WorkOS, picks a workspace, clicks Allow. Cowork caches the access + refresh tokens and silently refreshes them. Subsequent calls are zero-friction.

User-visible strings are plain language. The agent should never surface "transcript", "JSONL", "presigned PUT", "MCP", or other implementation language.

## Architecture

```
lore-plugin/
├── .claude-plugin/marketplace.json     # lists both plugins
├── lore/                               # existing Claude Code plugin
│   ├── .claude-plugin/plugin.json
│   └── commands/{share,lore}.md
└── lore-cowork/                        # NEW
    ├── .claude-plugin/plugin.json
    ├── .mcp.json                       # registers host + cloud servers
    ├── commands/{share,lore}.md
    ├── server/lore-cowork-mcp          # committed Bun-compiled binary
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
    "lore-cowork-local": {
      "command": "${CLAUDE_PLUGIN_ROOT}/server/lore-cowork-mcp",
      "transport": "stdio"
    },
    "lore": {
      "transport": "streamable-http",
      "url": "https://lore.tanagram.ai/mcp"
    }
  }
}
```

The host stdio server is launched on demand by Cowork. The cloud server uses the Streamable HTTP transport from the 2025-03-26 MCP spec — Cowork supports both `http` and `streamable-http`; we use the explicit name for clarity.

### Host MCP server

**Runtime.** TypeScript source under `server-src/`, compiled via `bun build --compile --target=bun-darwin-arm64 server-src/index.ts --outfile server/lore-cowork-mcp`. Produces a single ~50MB binary with no runtime dependencies — works for non-developer Cowork users without a Node-on-PATH requirement. Committed to the repo so `/plugin install` ships it directly. Mac-arm64 only for v1, matching Cowork's ship surface and the existing CLI's `defaultSessionsRoot()` mac-only path.

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

Used unchanged. The plugin's only contribution is registering the URL in `.mcp.json`. Cowork handles:

1. Discovery via `GET https://lore.tanagram.ai/.well-known/oauth-authorization-server`.
2. Dynamic Client Registration via `POST /oauth/register` (RFC 7591, open).
3. PKCE-S256 authorization flow via browser pop to `/oauth/authorize`.
4. Token exchange at `/oauth/token` → 5-minute RS256 access JWT with `scope="mcp.read mcp.write"`, refresh token with rotation.
5. `Authorization: Bearer <jwt>` on every `POST /mcp` call. Silent refresh via rotating refresh token.

Tools available from the cloud MCP (post PR #458 + PR #484):

| Tool | Scope | Purpose |
|------|-------|---------|
| `share_session` | `mcp.write` | Persist transcript as a Lore thread, return `thread_id` + `thread_url` |
| `get_thread` | `mcp.read` | Fetch a single thread by id |
| `list_threads` | `mcp.read` | Paginated list across the caller's workspaces |
| `search_threads` | `mcp.read` | Title search across the caller's workspaces |

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

1. Call the `lore-cowork-local` MCP tool `read_local_session` with no arguments. The server resolves the current session from `COWORK_SESSION_ID` or the most-recently-modified session on disk. Returns `{ session_id, conversation_id, transcript, uploads, outputs }`.

2. If the user asked to share a *specific* older session ("share the one from yesterday", "share session abc-123"), call `list_local_sessions` first, pick the matching entry, then call `read_local_session({ session_id })`.

3. Call the `lore` MCP tool `share_session({ transcript, harness: 'cowork' })`. The `harness` value is required (per lore PR #484) and must be the literal string `'cowork'` for this plugin. Do NOT pass `workspace_id` — the cloud forces private visibility and that's the v1 default. Returns `{ thread_id, thread_url }`.

4. Respond in plain language. Surface `thread_url` as a clickable link. If `uploads` or `outputs` were non-empty, mention them briefly. Do not say "transcript", "JSONL", or "MCP".

Failure modes:
- `read_local_session` errors with "no Cowork session found" → ask the user if they want to share an older one (then list).
- `share_session` errors → surface the message, suggest retry. Auth errors mean Cowork will re-prompt for consent; let it happen.
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

Do not say "transcript", "JSONL", or "MCP" in user-facing text. Auth errors → Cowork handles re-consent; surface the message and let it run.
```

## Build, marketplace, and versioning

**Build script** (`scripts/build.sh`):

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun build --compile --target=bun-darwin-arm64 server-src/index.ts --outfile server/lore-cowork-mcp
```

**CI** verifies the committed binary matches `server-src/`. On PRs that touch `lore-cowork/server-src/**`, a GitHub Actions job runs `scripts/build.sh` and diffs against `server/lore-cowork-mcp`. Drift fails the PR — the contributor must rebuild and re-commit.

**Marketplace entry** in `.claude-plugin/marketplace.json`:

```json
{
  "name": "lore-cowork",
  "source": "./lore-cowork",
  "description": "Share your Cowork session to Lore and read threads back.",
  "homepage": "https://lore.tanagram.ai",
  "license": "MIT",
  "category": "collaboration",
  "keywords": ["lore", "tanagram", "cowork", "share", "threads"]
}
```

**Plugin manifest** at `lore-cowork/.claude-plugin/plugin.json` mirrors the existing `lore/` plugin: `name: "lore-cowork"`, `version: "0.1.0"`, same author and license blocks.

## Pre-ship verification list

Open assumptions to validate before tagging v0.1.0:

1. Cowork supports `"transport": "streamable-http"` MCP servers in plugin `.mcp.json`. **(User confirmed Cowork supports both `http` and `streamable-http`.)**
2. Cowork drives MCP-spec OAuth client-side: browser pop, PKCE, token cache, refresh-token rotation.
3. Cowork sets a `COWORK_SESSION_ID` env var when launching plugin stdio MCP servers. If not present, host falls back to newest-mtime — verify the fallback is acceptable UX.
4. Cowork executes committed binaries from `${CLAUDE_PLUGIN_ROOT}/server/`. Verify path templating works and the binary executes (no Gatekeeper or quarantine blocks for plugin-shipped binaries).
5. Realistic `audit.jsonl` size doesn't blow the agent's context budget on share. Spot-check with a representative session.

If item 1 or 2 turns out false, fallback design: the host MCP server proxies all four tools to the cloud, using a token obtained via a host-side `lore_login` flow (device-code OAuth in a host tool). The host expands its surface; the agent's tool-calling pattern stays identical.

## Out of scope for v1

- mac-x86_64 and linux binaries (matrix build + release artifacts)
- `list_workspaces` cloud MCP tool for workspace-visible share-by-default
- Attaching upload/output file bytes to the Lore thread (today: filenames only)
- Semantic search across thread bodies (today: title search only)
- Skill registration — Cowork plugins surface MCP tool descriptions to the agent on every turn; that's the right place for trigger phrases
