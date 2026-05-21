# Lore plugin — design

The `lore/` package is a single shared plugin bundle for Claude Code and Codex. It ships one local stdio MCP server, one auth/proxy layer for the Lore cloud, and one `skills/` tree that both hosts can understand.

It also knows how to read local sessions from three runtimes:

- Claude Code
- Cowork
- Codex

That lets every host use the same high-level flow: resolve the active local session on disk, upload it directly to Lore with the correct harness, and read Lore threads back without pushing full transcript bytes through the agent context.

## Goals

- Keep the package layout shared across hosts instead of maintaining a Codex-only shim.
- Let the local MCP server do the privileged work the agent cannot do itself: read session files and manage auth.
- Reuse the Lore cloud MCP for thread storage and retrieval instead of reimplementing those APIs locally.
- Keep share flows efficient by sending transcript bytes straight from disk to Lore.

## Package layout

```text
lore/
├── .claude-plugin/plugin.json
├── .codex-plugin/plugin.json
├── .mcp.json
├── assets/
│   └── lore.svg
├── skills/
│   ├── lore/SKILL.md
│   └── share/SKILL.md
├── server/
│   └── lore-mcp
├── server-src/
│   ├── index.ts
│   ├── lib/
│   │   ├── auth/
│   │   ├── session/
│   │   │   ├── claudeCode.ts
│   │   │   ├── cowork.ts
│   │   │   ├── codex.ts
│   │   │   └── index.ts
│   │   └── cloudCall.ts
│   └── tools/
│       ├── lore_login.ts
│       ├── lore_login_resume.ts
│       ├── readLocalSession.ts
│       ├── listLocalSessions.ts
│       └── share_session.ts
└── README.md
```

The shared prompts live under `skills/` rather than a host-specific `commands/` tree. Host manifests sit beside each other, but the runtime and prompt surface are shared.

## Local MCP server

`.mcp.json` registers one bundled stdio server, `lore-local`, backed by the committed Bun executable at `server/lore-mcp`.

That server exposes two kinds of tools:

- Local session tools:
  `list_local_sessions`, `read_local_session`, `share_session`
- Lore cloud proxy tools:
  `get_thread`, `list_threads`, `search_threads`, `lore_login`, `lore_login_resume`

From the host agent's perspective there is just one MCP server. The local process decides whether a request needs filesystem access, cloud access, or both.

## Session detection

`server-src/lib/session/index.ts` picks a `SessionSource` implementation at call time.

Detection order:

1. `CLAUDE_SESSION_ID` present: use Claude Code
2. `COWORK_SESSION_ID` present: use Cowork
3. `CODEX_THREAD_ID` or `CODEX_SESSION_ID` present: use Codex
4. Otherwise, compare the newest on-disk session from each runtime and pick the freshest one
5. If nothing exists, fall back to Claude Code for the most useful error path

Runtime-specific readers:

- Claude Code:
  reads from Claude's project-scoped session layout
- Cowork:
  reads from Cowork's local-agent session layout
- Codex:
  reads from `~/.codex/sessions` and supports `CODEX_THREAD_ID` / `CODEX_SESSION_ID`

Every reader normalizes to the same `SessionPayload` shape: session id, optional conversation id, transcript text, uploads, outputs, and transcript path.

## Share flow

The shared `skills/share/SKILL.md` intentionally tells the agent to call `share_session` directly, not `read_local_session` first.

Why:

- transcript files can be large
- the plugin can read them locally without involving the agent context
- Lore only needs the final upload plus metadata, not an agent-mediated round trip

Actual flow:

1. Agent calls `share_session({ session_id? })` on `lore-local`
2. The tool resolves the target session on disk
3. The tool reads transcript, uploads, and outputs locally
4. The tool maps the detected runtime to a Lore harness
5. The tool calls the Lore cloud `share_session` API
6. The tool returns `{ thread_id, thread_url }` plus an optional tip

Harness mapping:

- Claude Code -> `claudeCode`
- Cowork -> `cowork`
- Codex -> `codex`

Codex must upload as `codex`, not `cowork`, because Lore has separate handling for that harness.

`read_local_session` still exists for debugging and explicit read workflows, but it is no longer the normal share path.

## Read flow

The shared `skills/lore/SKILL.md` routes user intent to the Lore thread tools:

- thread id or Lore URL -> `get_thread`
- keyword query -> `search_threads`
- recent/latest/no query -> `list_threads`

These calls do not need local session access. They are simple authenticated proxies to the Lore cloud MCP.

## Auth flow

Auth runs inside the local MCP server via `lib/auth/`.

Flow summary:

1. Discover the protected resource and authorization server from Lore
2. Start WorkOS AuthKit device authorization when needed
3. Open the browser automatically when possible
4. Persist tokens under `~/Library/Application Support/tanagram/lore/tokens.json`
5. Refresh silently when access tokens are near expiry
6. On cloud-side 401, clear local tokens and ask the agent to run `lore_login` again

This keeps both Claude Code and Codex on the same auth path. No separate CLI bootstrap is required for the plugin package.

## Why `skills/` instead of `commands/`

The package is meant to be host-agnostic at the prompt layer. `skills/` is the shared convention that works cleanly across agents, while a `commands/` tree implies host-specific routing and encourages duplicated packaging.

Renaming the prompt surface to `skills/` keeps the Claude Code and Codex bundles aligned:

- same MCP server
- same auth flow
- same share/read instructions
- same package root

## Build and verification

The checked-in binary is built from `server-src/` with Bun and committed under `server/lore-mcp`.

Useful checks while developing:

- `bun test`
- `bun run typecheck`
- `git diff --check`

When `server-src/` changes, rebuild the binary so the committed executable matches source.

## Current scope

Supported now:

- macOS arm64 packaged binary
- Claude Code and Codex host manifests
- Claude Code, Cowork, and Codex session readers
- direct Lore share and thread read flows

Still intentionally out of scope:

- linux and Intel macOS binaries
- attaching full upload/output file contents to threads
- workspace selection during share
- separate host-specific plugin packages
