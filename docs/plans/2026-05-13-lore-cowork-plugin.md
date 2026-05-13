# Lore Cowork Plugin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task.

**Goal:** Ship a `lore-cowork` plugin in this marketplace that lets Cowork users share their current session to Lore and read Lore threads back, via a host-side stdio MCP server (for local session bytes) plus the cloud Lore MCP at `https://lore.tanagram.ai/mcp` (for upload/read).

**Architecture:** Plugin `.mcp.json` registers two servers — a Bun-compiled mac-arm64 stdio binary exposing `list_local_sessions` and `read_local_session` (reads `~/Library/Application Support/Claude/local-agent-mode-sessions/`), and the cloud Lore MCP (streamable-http, OAuth-protected, fully Cowork-driven for auth). Two slash commands (`/share`, `/lore`) instruct the agent how to chain the tools.

**Tech Stack:** TypeScript ESM, `@modelcontextprotocol/sdk` stdio transport, Bun for build (`bun build --compile`) and tests (`bun test`).

**Design doc:** [lore-cowork/DESIGN.md](../../lore-cowork/DESIGN.md)

## Rationale

The decomposition follows the dependency chain from leaves to integration:

1. **Plugin metadata first** (Task 1) — independent, lets reviewers see the marketplace entry early, and unblocks `/plugin install` testing once binaries land.
2. **Server scaffold then session library then tools** (Tasks 2–5) — strict bottom-up. The session-reading lib has no deps; each tool depends on the lib + scaffold; index.ts registration is modified twice (sequential to avoid merge conflicts on a single small file).
3. **Build → binary → `.mcp.json`** (Tasks 6–7) — the binary path is what `.mcp.json` references; committing the binary is what makes `/plugin install` produce a working plugin. `.mcp.json` is meaningless without the binary at the expected path.
4. **Final wiring in parallel** (Tasks 8–9) — slash commands and CI workflow are independent of each other; both depend on Tasks 6–7 being complete. README (Task 10) waits until everything else is in to describe accurately.

No task ships a partial-feature: every commit leaves the plugin in a state that either has no functional change yet (Tasks 1–5 alone don't change Cowork behavior because `.mcp.json` isn't wired) or has end-to-end functionality (Task 7 onwards).

---

### Task 1: Plugin metadata and marketplace entry

**Why:** Establishes the plugin's identity in the marketplace so `/plugin install lore-cowork@tanagram` is discoverable. Pure metadata — no runtime change.

**Files:**
- Create: `lore-cowork/.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

**Contract:**

`plugin.json` mirrors `lore/.claude-plugin/plugin.json` with:
```json
{
  "name": "lore-cowork",
  "description": "Share Cowork sessions to Lore and read threads back.",
  "version": "0.1.0",
  "author": { "name": "Tanagram", "url": "https://tanagram.ai" },
  "homepage": "https://lore.tanagram.ai",
  "license": "MIT",
  "keywords": ["lore", "tanagram", "cowork", "share", "threads"]
}
```

`marketplace.json` gains a second entry in `plugins[]`:
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

**Acceptance:**
- `.claude-plugin/marketplace.json` validates as JSON and lists both `lore` and `lore-cowork`.
- The existing `lore` plugin entry is unchanged.
- `lore-cowork/.claude-plugin/plugin.json` validates as JSON and matches the contract above.

**Constraints:**
- Do not edit `lore/` or any existing plugin files except `marketplace.json`.
- Marketplace entry `source` must be `./lore-cowork` (relative path from repo root).

---

### Task 2: Host MCP server scaffold

**Why:** Establishes the Bun + TypeScript project that produces the host binary. Boots an MCP stdio server with no tools registered yet — runnable but inert. Subsequent tasks register tools.

**Files:**
- Create: `lore-cowork/package.json`
- Create: `lore-cowork/tsconfig.json`
- Create: `lore-cowork/server-src/index.ts`
- Create: `lore-cowork/.gitignore`

**Contract:**

`package.json` declares dev-only deps:
- `@modelcontextprotocol/sdk` ^1.29.0 (matches lore monorepo)
- `typescript` ^5.x
- `@types/node` ^20.x
- `type: "module"` and `private: true`
- Scripts: `build` → invokes `scripts/build.sh`, `test` → `bun test`, `typecheck` → `tsc --noEmit`

`tsconfig.json` targets `ES2022`, `module: "ESNext"`, `moduleResolution: "Bundler"`, `strict: true`, `noEmit: true`. `rootDir: "server-src"`, `types: ["bun"]`.

`server-src/index.ts` exports `main()`:
```ts
async function main(): Promise<void> {
  const server = new Server({ name: 'lore-cowork-mcp', version: '0.1.0' });
  // tool registration intentionally empty here; subsequent tasks add tools
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```
Invoked at module load when run directly. Uses the SDK's low-level `Server` from `@modelcontextprotocol/sdk/server/index.js` and `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`.

`.gitignore` excludes `node_modules/`, `*.log`, `.DS_Store`. Does NOT exclude `server/lore-cowork-mcp` — that binary IS committed.

**Acceptance:**
- `bun install` in `lore-cowork/` succeeds.
- `bun run typecheck` exits 0.
- `bun run server-src/index.ts` boots the server, exits cleanly when stdin closes.
- `ListToolsRequest` over stdio returns an empty `tools` array.

**Constraints:**
- Do not use Node 20-specific APIs that Bun doesn't support (esp. `node:fs/promises` is fine; `node:test` is not — use `bun test`).
- ESM only. No CommonJS.
- `@modelcontextprotocol/sdk` version must match lore monorepo's pin to avoid drift.

---

### Task 3: Cowork session library

**Why:** Encapsulates filesystem access — locating the sessions root, enumerating sessions, walking into `local_*/`, reading `audit.jsonl`. Tools depend on it. Direct port from the lore monorepo to keep behavior identical to the existing CLI.

**Files:**
- Create: `lore-cowork/server-src/lib/session.ts`
- Test: `lore-cowork/server-src/lib/session.test.ts`

**Contract:**

Ported from `~/repos/lore/apps/cli/src/upload/cowork/resolveSession.ts` and `readSession.ts`. Exports:

```ts
export const SESSIONS_DIR_NAME = 'local-agent-mode-sessions';

export type ListedSession = {
  conversationId: string;
  sessionId: string;
  sessionDir: string;
  mtimeMs: number;
};

export type SessionContents = {
  transcriptPath: string;
  transcript: string;
  uploads: string[];
  outputs: string[];
};

export function defaultSessionsRoot(home?: string): string;
export function listSessions(sessionsRoot: string): ListedSession[];
export function findLatestSession(sessionsRoot: string): ListedSession | null;
export function readSession(sessionDir: string): SessionContents;
```

Semantics match the lore monorepo originals byte-for-byte:
- `defaultSessionsRoot` → `<home>/Library/Application Support/Claude/local-agent-mode-sessions`.
- `listSessions` returns `[]` when root doesn't exist; sorts newest-mtime first.
- `readSession` walks into the `local_*` subdir, tries `audit.jsonl` then `transcript.jsonl`, throws with the original actionable messages when neither is found.

**Acceptance:**
- All exported functions have unit tests using a tmpdir fixture mirroring the real session layout.
- `defaultSessionsRoot()` returns the right path with a stubbed `home`.
- `listSessions` on a populated root returns entries newest-first; on a missing root returns `[]`.
- `readSession` returns transcript bytes + basename arrays; throws the documented error when `local_*` is missing; throws the documented error when no transcript file exists.
- Tests pass under `bun test`.

**Constraints:**
- Public API matches the originals' shape to ease future extraction into a shared `@tanagram/cowork-session` package.
- Synchronous `node:fs` calls only (matches the originals; the data volume doesn't justify async).
- Mac-arm64 path semantics; do not introduce cross-platform branching in v1.

---

### Task 4: `list_local_sessions` tool

**Why:** Lets the agent browse older sessions when the user asks to share something other than the current one. The default share flow does not call this — but the tool exists for explicit selection.

**Files:**
- Create: `lore-cowork/server-src/tools/listLocalSessions.ts`
- Modify: `lore-cowork/server-src/index.ts` (register the tool)
- Test: `lore-cowork/server-src/tools/listLocalSessions.test.ts`

**Contract:**

```ts
export type ListLocalSessionsResult = {
  sessions: Array<{
    session_id: string;
    conversation_id: string;
    mtime_ms: number;
  }>;
};

export const listLocalSessionsTool: ToolDefinition;
```

`ToolDefinition` is the SDK's tool shape — `name`, `description`, `inputSchema`, handler. Tool name: `list_local_sessions`. Input schema: empty object, `additionalProperties: false`. Description tells the agent this is for browsing older sessions; the default share flow does not call it.

Handler reads `defaultSessionsRoot()`, calls `listSessions`, returns the mapped result. No args means no validation needed beyond the SDK's protocol-level checks.

`index.ts` imports `listLocalSessionsTool` and registers it with the server's `CallToolRequest` / `ListToolsRequest` handlers (same registration pattern as `~/repos/lore/apps/api/src/mcp/server.ts`).

**Acceptance:**
- `ListToolsRequest` over stdio includes `list_local_sessions` with the documented input schema.
- `CallToolRequest({name: "list_local_sessions"})` against a tmpdir fixture returns sessions newest-first.
- Against an empty/missing root returns `{ sessions: [] }`.
- Handler does not throw on a missing sessions root — it returns an empty array (matches CLI behavior).

**Constraints:**
- Tool must not read any env vars or arguments — list is unconditional.
- Result must be JSON-serializable; no Date instances, only `mtime_ms` numbers.

---

### Task 5: `read_local_session` tool

**Why:** The core of the share flow. Returns the transcript bytes and artifact filenames the agent needs to call cloud `share_session`. Implements the session-resolution priority (explicit arg → env var → newest mtime) on the host side, so the agent's call is parameter-free for the default case.

**Files:**
- Create: `lore-cowork/server-src/tools/readLocalSession.ts`
- Modify: `lore-cowork/server-src/index.ts` (register the tool)
- Test: `lore-cowork/server-src/tools/readLocalSession.test.ts`

**Contract:**

```ts
export type ReadLocalSessionArgs = {
  session_id?: string;
};

export type ReadLocalSessionResult = {
  session_id: string;
  conversation_id: string;
  transcript: string;
  uploads: string[];
  outputs: string[];
};

export const readLocalSessionTool: ToolDefinition;
```

Tool name: `read_local_session`. Input schema: `{ session_id?: string }`, `additionalProperties: false`.

**Resolution priority** (handler logic):
1. If `args.session_id` is a non-empty string → find that session in `listSessions(root)`; throw `McpError(InvalidParams, "session not found: <id>")` if absent.
2. Else if `process.env.COWORK_SESSION_ID` is set and non-empty → resolve to that session id; throw `McpError(InvalidParams, "session not found: <id>")` if absent.
3. Else → `findLatestSession(root)`. Throw `McpError(InvalidParams, "no Cowork session found")` if `null`.

Once resolved: call `readSession(sessionDir)`. Errors from the lib (missing `local_*` subdir, missing transcript) → `McpError(InvalidParams, <lib error message>)`. Other filesystem errors → `McpError(InternalError, "failed to read session: <sanitized>")`.

Returns the result shape above. `session_id` and `conversation_id` come from the resolved session entry, not parsed from path internals downstream.

**Acceptance:**
- `CallToolRequest({name: "read_local_session"})` with no args, against a fixture with one session and no env var set, returns that session's contents.
- With `COWORK_SESSION_ID` env set to a real session id, the tool returns that session regardless of mtime.
- With `session_id` arg set to a real session id, returns that session regardless of env var or mtime.
- `session_id` arg taking priority over env var verified.
- Bogus `session_id` arg → `McpError` with `InvalidParams` code and a message including the id.
- Missing transcript file → `McpError(InvalidParams, ...)` with the lib's actionable message.
- No sessions at all → `McpError(InvalidParams, "no Cowork session found")`.

**Constraints:**
- Empty/whitespace `session_id` is treated as omitted (do not pass it through to the lookup).
- Tool reads `process.env.COWORK_SESSION_ID` lazily on each call, not at module load — supports tests that mutate env.
- Transcript is returned verbatim as a string; do not validate or parse it.

---

### Task 6: Build script and committed binary

**Why:** Produces the Bun-compiled mac-arm64 binary at the path `.mcp.json` will reference. Committing the binary is what makes `/plugin install` ship a working server with no second-step build on the user's machine.

**Files:**
- Create: `lore-cowork/scripts/build.sh`
- Create: `lore-cowork/server/README.md`
- Create: `lore-cowork/server/lore-cowork-mcp` (binary artifact)

**Contract:**

`scripts/build.sh`:
- Bash, `set -euo pipefail`.
- `cd` to `lore-cowork/` regardless of caller's cwd.
- Runs: `bun build --compile --target=bun-darwin-arm64 server-src/index.ts --outfile server/lore-cowork-mcp`.
- Executable: `chmod +x scripts/build.sh`.

`server/README.md` documents:
- The binary is built from `server-src/` via `scripts/build.sh`.
- Target: `bun-darwin-arm64` only for v1.
- Rebuild required when `server-src/**` changes; CI enforces.
- Bun version requirement (whichever stable version is in use at build time — pin in build.sh comment).

`server/lore-cowork-mcp`:
- The actual compiled binary, committed.
- File mode includes execute bit (`chmod +x`).
- Tracked by git as a binary file (`server/lore-cowork-mcp binary` in `.gitattributes` if needed).

**Acceptance:**
- `bash lore-cowork/scripts/build.sh` from the repo root produces `lore-cowork/server/lore-cowork-mcp`.
- The produced binary is executable.
- Running the binary directly with no stdin emits the MCP initialize handshake on stdout, then exits when stdin closes.
- `ListToolsRequest` over stdio against the binary lists both `list_local_sessions` and `read_local_session`.
- The binary is committed to git with execute permissions preserved.

**Constraints:**
- Build target is exactly `bun-darwin-arm64`. Do not add other targets in v1.
- Binary path is exactly `lore-cowork/server/lore-cowork-mcp`. `.mcp.json` will hardcode this.
- Do not commit source maps or intermediate artifacts — only the single compiled binary.

---

### Task 7: `.mcp.json` server registration

**Why:** Tells Cowork to launch the bundled binary as one MCP server and to connect to the cloud Lore MCP as another. Without this, Cowork doesn't know either exists.

**Files:**
- Create: `lore-cowork/.mcp.json`

**Contract:**

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

**Acceptance:**
- File validates as JSON.
- `${CLAUDE_PLUGIN_ROOT}` template literal is preserved as-is (Cowork resolves it at runtime — do not expand at write time).
- The two server keys are exactly `lore-cowork-local` and `lore` (referenced by slash commands).
- `transport` values are `"stdio"` and `"streamable-http"` respectively.

**Constraints:**
- Do not embed any auth tokens or headers — Cowork drives OAuth client-side.
- The local server has no `args`, no `env` — the host server reads `COWORK_SESSION_ID` from whatever env Cowork passes; no other config needed.
- Do not add a third server. The plan ships only these two.

---

### Tasks 8–9 (parallel): Slash commands and CI workflow

> These tasks are independent and can be executed in parallel.
> Both depend on: Task 7.

### Task 8: Slash commands

**Why:** The discoverable surface in `/plugin`. Tells the agent how to chain the two MCP tools for share, and how to pick the right cloud tool for read. Encodes the plain-language tone and failure-recovery UX.

**Files:**
- Create: `lore-cowork/commands/share.md`
- Create: `lore-cowork/commands/lore.md`

**Contract:**

Both files have frontmatter with a `description:` field (used by `/plugin` discovery). Body is short LLM-directed prose — no bash blocks.

`share.md` body must instruct the agent to:
1. Default flow: call `lore-cowork-local`/`read_local_session` with no args.
2. Specific older-session flow: call `list_local_sessions` first, pick the matching entry, then `read_local_session({session_id})`.
3. Call `lore`/`share_session({transcript, harness: 'cowork'})` with the result. The `harness` value is **required** per [lore PR #484](https://github.com/tanagram/lore/pull/484) and must be the literal string `'cowork'`. Do NOT pass `workspace_id` (forces private).
4. Render `thread_url` to the user as a clickable link with brief artifact mention if `uploads`/`outputs` non-empty.
5. Plain language only — never say "transcript", "JSONL", "MCP".
6. Failure handling: no-session → ask if they want an older one; share errors → surface verbatim; auth errors → Cowork handles re-consent.

`lore.md` body must instruct the agent to:
1. Detect input shape: thread id (`th_...`) or URL → `get_thread`; keywords → `search_threads`; "recent"/"latest"/empty → `list_threads`.
2. Render in plain language: single fetch surfaces URL + title + author; lists are one-liners.
3. Empty results → suggest loosening the query.
4. Same auth-error and tone rules as `share.md`.

Final content matches the templates in [lore-cowork/DESIGN.md § "Slash commands"](../../lore-cowork/DESIGN.md).

**Acceptance:**
- Both files have valid frontmatter with `description:` fields.
- Both reference the correct MCP server names from `.mcp.json` (`lore-cowork-local` for host tools, `lore` for cloud tools).
- Both reference tool names that exist (`list_local_sessions`, `read_local_session`, `share_session`, `get_thread`, `list_threads`, `search_threads`).
- `share.md` explicitly instructs the agent to pass `harness: 'cowork'` to `share_session` (required per lore PR #484; missing → InvalidParams).
- Neither file invokes bash.
- Tone audit: no occurrence of "transcript", "JSONL", "MCP", "presigned" in any user-facing instruction (allowed in tool-selection prose addressed to the agent).

**Constraints:**
- Slash commands are the only user-discoverable surface in `/plugin` — keep them clear, jargon-free, and aligned with the existing Claude Code plugin's voice.
- Do not duplicate MCP tool schemas — Cowork surfaces those to the agent automatically.

### Task 9: CI binary-drift check

**Why:** Prevents `server-src/` and the committed binary from diverging. If a contributor changes the source without rebuilding, CI fails the PR.

**Files:**
- Create: `.github/workflows/build-cowork-server.yml`

**Contract:**

GitHub Actions workflow:
- Trigger: `pull_request` on paths `lore-cowork/server-src/**`, `lore-cowork/scripts/build.sh`, `lore-cowork/package.json`, `lore-cowork/tsconfig.json`.
- Runs on `macos-14` (arm64 runner; matches the build target).
- Steps:
  1. Checkout.
  2. Install Bun (pinned version matching the local `build.sh`).
  3. `bun install` in `lore-cowork/`.
  4. `bash lore-cowork/scripts/build.sh`.
  5. `git diff --exit-code lore-cowork/server/lore-cowork-mcp` — fails if drift.

**Acceptance:**
- Workflow file validates as YAML and triggers on the documented paths.
- Running the workflow on a PR that modifies `server-src/` without rebuilding the binary produces a failing diff step.
- Running on a PR that modifies `server-src/` AND includes a rebuilt binary passes.
- Running on a PR that touches no in-trigger paths skips the workflow.

**Constraints:**
- Must use a macOS arm64 runner — cross-compiling Bun's `darwin-arm64` target from another OS is not supported by `bun build --compile`.
- Do not auto-commit the rebuilt binary from CI — the PR author must do that locally and push.
- Do not run `bun test` here — tests have their own workflow scope (or could be added in a follow-up). This workflow is binary-drift only.

---

### Task 10: README

**Why:** First impression for anyone landing on the plugin from `/plugin marketplace` or GitHub. Describes what the plugin does, how to install, what to expect on first use (OAuth pop, etc.).

**Files:**
- Create: `lore-cowork/README.md`

**Contract:**

Sections, in order:
1. **Title + tagline** — one sentence.
2. **Install** — the `/plugin marketplace add` + `/plugin install lore-cowork@tanagram` commands.
3. **What you get** — bullets describing `/share` and `/lore`.
4. **First-time setup** — note that the first share or read triggers a browser OAuth flow to lore.tanagram.ai; user picks a workspace; Cowork caches the token.
5. **Architecture** — one paragraph: stdio host server reads local session bytes, cloud MCP does upload/read, OAuth handled by Cowork. Link to `DESIGN.md`.
6. **Requirements** — macOS arm64 only for v1.
7. **License** — MIT.

Tone matches the existing `lore/`-plugin [README.md](../../README.md) at the repo root.

**Acceptance:**
- README renders cleanly as Markdown.
- All install commands are copy-pasteable and accurate.
- Links to `DESIGN.md` and `lore.tanagram.ai` work.
- Does not promise capabilities the v1 plugin doesn't ship (no semantic search, no artifact upload, no workspace-default visibility).

**Constraints:**
- Do not duplicate `DESIGN.md` content — README is short and onboarding-focused; DESIGN is the source of truth.
- Mention the v1 mac-arm64 limit upfront so non-mac users aren't surprised.

---

## Pre-ship verification (out-of-plan)

Items from the design's "Pre-ship verification list" that don't map to code tasks — flagged here for manual verification before tagging `v0.1.0`:

1. Cowork supports `"transport": "streamable-http"` in plugin `.mcp.json`. (User confirmed.)
2. Cowork drives MCP-spec OAuth client-side (browser pop, PKCE, token cache, refresh).
3. Cowork sets `COWORK_SESSION_ID` env var when launching plugin stdio MCP servers — otherwise the host falls back to newest-mtime (acceptable but worth confirming).
4. Cowork executes committed binaries from `${CLAUDE_PLUGIN_ROOT}/server/` (no Gatekeeper / quarantine blocks).
5. Real `audit.jsonl` sizes don't blow the agent's context budget on share.
