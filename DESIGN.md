# Lore plugin — design

The shared Lore plugin package is a single bundle for Claude Code, Codex, and Amp. It ships one local stdio MCP server, one auth/proxy layer for the Lore cloud, one `skills/` tree for hosts that consume skills, and a thin Amp TypeScript adapter for Amp-native commands/tools.

It knows how to read local sessions from three on-disk runtimes:

- Claude Code
- Cowork
- Codex

Amp is intentionally different: the Amp adapter exports an explicitly resolved Amp thread with the local `amp threads export <thread_id>` command, then delegates the upload to the same Lore share core with `harness: 'amp'`.

## Goals

- Keep the package layout shared across hosts instead of maintaining host-specific upload/auth shims.
- Let the local MCP server do privileged work the agent cannot do itself: read local session files and manage auth.
- Reuse the Lore cloud MCP for thread storage and retrieval instead of reimplementing those APIs locally.
- Keep share flows efficient by sending transcript bytes straight from the local host to Lore.
- Keep Amp support thin: Amp owns command/tool registration and thread export; shared Lore code owns auth, upload, and cloud reads.
- Keep background-capture configuration and lifecycle out of the plugin.

## Capture ownership boundary

The plugin is a discovery, manual-share, local-read, authentication, and cloud-consumption surface. It does not configure, install, enable, disable, inspect, or execute background capture.

The Lore desktop app owns its embedded capture process and the **Configure Session Uploads** UI. The interactive CLI owns standalone upload configuration (`lore configure`) and background-agent lifecycle. Plugin code must not shell out to those CLI commands or maintain a parallel consent/configuration state machine. The only plugin state retained is a share counter used to show the desktop discovery tip after the first three successful manual shares; legacy consent and dismissal fields are ignored when older state files are read.

## Package layout

```text
plugin-root/
├── .amp/
│   └── plugins/
│       └── lore.ts                  # Amp-layout delegate to amp/lore.ts
├── .claude-plugin/plugin.json
├── .codex-plugin/plugin.json
├── .mcp.json
├── amp/
│   └── lore.ts                      # canonical Amp plugin implementation
├── assets/
│   └── lore.svg
├── skills/
│   ├── read/SKILL.md
│   └── share/SKILL.md
├── server/
│   └── lore-mcp
├── server-src/
│   ├── amp/
│   │   ├── ampToolAdapter.ts
│   │   ├── shareAmpThread.ts
│   │   └── types.d.ts
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

The shared prompts live under `skills/` rather than a host-specific `commands/` tree. Host manifests sit beside each other, and the Amp plugin entrypoint sits beside them without copying cloud upload or registration logic.

## Local MCP server

The root `.mcp.json` registers one bundled stdio server, `lore-local`, for Claude Code and Cowork using their plugin-root expansion. The Codex manifest points to `.codex-plugin/mcp.json`, which registers the same executable with a plugin-root-relative `cwd` as required by Codex. Both configurations run the committed Bun executable at `server/lore-mcp`.

That server exposes two kinds of tools:

- Local session tools: `list_local_sessions`, `read_local_session`, `share_session`
- Lore cloud proxy tools: `get_thread`, `list_threads`, `fork_thread`, `search_threads`, `lore_login`, `lore_login_resume`

Cloud-facing Lore MCP tool metadata lives in `packages/contracts/src/mcp.ts`. The plugin imports those specs to generate stdio proxy tools for cloud-owned tools such as `list_threads`, `get_thread`, `fork_thread`, and `search_threads`; it should not hand-maintain separate copies of those schemas. `share_session` is the intentional exception: the cloud schema requires `harness` and `transcript`, while the plugin-facing schema exposes only local session selection and highlight fields. The plugin reads the transcript from disk and forwards the cloud-shaped payload internally.

From Claude Code/Cowork/Codex, there is just one MCP server. The local process decides whether a request needs filesystem access, cloud access, or both. Amp uses the same cloud/auth tool implementations for reads and login, but its share command/tool calls the Amp adapter because Amp threads come from the Amp CLI export command rather than `server-src/lib/session`.

## Session detection

`server-src/lib/session/index.ts` picks a `SessionSource` implementation at call time for the shared `share_session` MCP tool.

Detection order:

1. `CLAUDE_CODE_SESSION_ID` (or back-compat alias `CLAUDE_SESSION_ID`) present: use Claude Code
2. `COWORK_SESSION_ID` present: use Cowork
3. `CODEX_THREAD_ID` or `CODEX_SESSION_ID` present: use Codex
4. Otherwise, compare the newest on-disk session from each runtime and pick the freshest one
5. If nothing exists, fall back to Claude Code for the most useful error path

Runtime-specific readers:

- Claude Code: reads from Claude's project-scoped session layout
- Cowork: reads from Cowork's local-agent session layout
- Codex: reads from `~/.codex/sessions` and supports `CODEX_THREAD_ID` / `CODEX_SESSION_ID`

Every reader normalizes to the same `SessionPayload` shape: session id, optional conversation id, transcript text, uploads, outputs, and transcript path.

Amp is not a `SessionSource` in the MVP. Amp sharing is host-specific because the adapter resolves a thread ID from the command context, an explicit tool input, or `AMP_CURRENT_THREAD_ID`, then exports the raw session through `amp threads export <thread_id>` instead of using the shared on-disk session detector. The Amp command and natural-language tool both call the same `shareAmpThread` helper, which delegates upload/auth behavior to the existing `runShareSession` core.

## Share flow

The shared `skills/share/SKILL.md` intentionally tells Claude Code/Cowork/Codex agents to call `share_session` directly, not `read_local_session` first.

Why:

- transcript files can be large
- the plugin can read them locally without involving the agent context
- Lore only needs the final upload plus metadata, not an agent-mediated round trip

Claude Code/Cowork/Codex flow:

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
- Amp -> `amp`

Codex must upload as `codex`, not `cowork`, because Lore has separate handling for that harness.

Amp flow:

1. Amp command palette invokes **Lore: Share active Amp thread**, or the agent invokes `share_current_amp_thread` with `{ thread_id?, visibility? }`
2. The command uses `ctx.thread?.id`; the tool does not rely on tool context and instead uses explicit `thread_id` or `AMP_CURRENT_THREAD_ID`
3. `shareAmpThread` runs `amp threads export <thread_id>` and keeps the raw JSON intact
4. `shareAmpThread` calls the existing `runShareSession` core with `{ transcript, title?, source_url?, visibility? }` and `{ harness: 'amp' }`
5. Lore cloud stores the raw Amp export, and the server-side uploaded-thread parser routes `harness: 'amp'` files to the Amp transcript parser
6. The command includes the returned `thread_url` in its notification, writes it into the Amp thread when Amp exposes a writable thread, copies it to the local clipboard, and shows it in a copyable dialog only when the thread append or clipboard copy is unavailable. Clipboard/dialog failures are reported in the notification instead of failing the successful share. The tool returns text/JSON output suitable for Amp.

`read_local_session` still exists for debugging and explicit read workflows, but it is no longer the normal share path.

## Amp installation and reload

Amp uses TypeScript plugin files instead of the Claude/Codex manifests. Local install paths are:

- Project plugin: `.amp/plugins/*.ts`
- System plugin: `~/.config/amp/plugins/*.ts`

The canonical implementation is `amp/lore.ts`. `packages/lore-plugin/.amp/plugins/lore.ts` is a thin local-layout entrypoint that re-exports the canonical implementation so there is an obvious file in Amp's expected shape without duplicated registrations. Keep that package layout intact; neither `.amp/plugins/lore.ts` nor `amp/lore.ts` is standalone — they import shared files from this checkout.

For local development in the Lore monorepo, run Amp from `packages/lore-plugin` so it can load `packages/lore-plugin/.amp/plugins/lore.ts`. For a user-level local install while iterating on a monorepo checkout, symlink the canonical Amp implementation file and keep the relative package files available:

```bash
mkdir -p ~/.config/amp/plugins
ln -s "$(pwd)/packages/lore-plugin/amp/lore.ts" ~/.config/amp/plugins/lore.ts
```

If you run those commands from `packages/lore-plugin`, use `$(pwd)/amp/lore.ts` as the symlink target instead. After installing or changing the plugin, reload Amp from the command palette with `plugins: reload`.

No Amp marketplace distribution is assumed or documented for this MVP.

## Read flow

The shared `skills/read/SKILL.md` surfaces as `/lore:read` and routes user intent to the Lore thread tools:

- thread id or Lore URL -> `get_thread`
- keyword query -> `search_threads`
- recent/latest/no query -> `list_threads`

These calls do not need local session access. They are simple authenticated proxies to the Lore cloud MCP, and the Amp plugin registers the same safe read/auth tools through the shared tools barrel.

The shared `skills/fork/SKILL.md` surfaces as `/lore:fork` and calls `fork_thread({ thread_id, forker_intent })` to fetch `source_distilled`, an intent-conditioned handoff summary for continuing from a visible Lore thread.

## Auth flow

Auth runs inside the local MCP server via `lib/auth/` and is reused by Amp share/read flows.

Flow summary:

1. Discover the protected resource and authorization server from Lore
2. Start WorkOS AuthKit device authorization when needed
3. Open the browser automatically when possible
4. Persist tokens through `@lore/identity-store` under the canonical `~/.lore/tokens.json` shared with the CLI
5. Refresh silently when access tokens are near expiry
6. On cloud-side 401, clear local tokens and ask the agent to run `lore_login` again

This keeps Claude Code, Cowork, Codex, and Amp on the same auth path. No separate CLI bootstrap is required for the plugin package.

## Why `skills/` instead of `commands/`

The package is meant to be host-agnostic at the prompt layer. `skills/` is the shared convention that works cleanly across agents, while a `commands/` tree implies host-specific routing and encourages duplicated packaging.

Renaming the prompt surface to `skills/` keeps the Claude Code and Codex bundles aligned:

- same MCP server
- same auth flow
- same share/read instructions
- same package root

Amp does not consume these skills directly; it gets Amp-native command and tool registrations from `amp/lore.ts` while still reusing the same Lore core.

## Build and verification

The checked-in binary is built from `server-src/` with Bun and committed under `server/lore-mcp`.

Useful checks while developing:

- `bun test`
- `bun run typecheck`
- `git diff --check`

When `server-src/` changes, rebuild the binary so the committed executable matches source. The Amp TypeScript source is included in package typechecking, but it does not produce a generated artifact in the current package layout.

## Current scope

Supported now:

- macOS arm64 packaged binary
- Claude Code and Codex host manifests
- Amp local TypeScript plugin entrypoint and `.amp/plugins/lore.ts` delegate
- Claude Code, Cowork, and Codex session readers
- Amp command-palette share of the active thread through `amp threads export`
- Amp explicit natural-language share tool with `{ thread_id?: string, visibility?: 'private' | 'workspace' | 'public' }`
- direct Lore share and thread read flows

Still intentionally out of scope:

- Linux and Intel macOS binaries
- attaching full upload/output file contents to threads
- workspace selection during share
- separate host-specific plugin packages
- Amp marketplace distribution claims
- automatic Amp active-thread injection for unrelated natural-language turns
