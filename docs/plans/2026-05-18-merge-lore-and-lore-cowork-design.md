# Merge `lore` and `lore-cowork` into a single `lore` plugin

**Status:** Design — approved, ready to plan execution.
**Author:** Quentin Donnelly
**Date:** 2026-05-18

## Background

This repo ships two Claude Code plugins side-by-side:

- **`lore/`** — thin shim. Slash commands `/share` and `/lore` shell out to the globally-installed `@tanagram/lore` npm CLI (bootstrapped via `npm install -g` on first use). Uses `CLAUDE_SESSION_ID` from the Claude Code runtime. No MCP server.
- **`lore-cowork/`** — heavy. Bundles a Bun-built MCP server (`lore-cowork-mcp`) that exposes `share_session`, `get_thread`, `list_threads`, `search_threads`, `lore_login`, `lore_login_resume`, `list_local_sessions`, `read_local_session`. Slash commands invoke MCP tools directly. Resolves sessions via `COWORK_SESSION_ID` or a most-recently-modified scan of the on-disk sessions directory.

The two plugins solve the same problem (share + read Lore threads) for two runtimes. The split is a historical artifact: the Claude Code plugin predates the bundled MCP server, and the MCP server was originally written for Cowork's session layout. Maintaining both is duplicate work, and they will only diverge further as features are added.

In parallel, tanagram/lore PR #595 has merged, cutting the hosted `/mcp` endpoint over to WorkOS AuthKit-issued JWTs. The follow-up PR #596 will delete the legacy custom OAuth surface entirely. The plugin's current device-code flow against `/oauth/device/code` and `/oauth/token` will stop working when #596 lands. We must migrate auth as part of this merge.

## Goals

1. Ship a single plugin named `lore` that works in **both** Claude Code and Cowork.
2. Drop the global `@tanagram/lore` CLI dependency from the plugin's runtime path.
3. Migrate authentication to WorkOS AuthKit using discovery-driven endpoint resolution.
4. Preserve the existing slash command surface (`/share`, `/lore`) so users see no behavior change at the command level.
5. Keep the `@tanagram/lore` CLI alive as a peer tool for the background watcher daemon and shell power use.

## Non-goals

- Adding new tools to the hosted MCP — this is a packaging and runtime change, not a feature addition.
- Auto-uninstalling the legacy `lore-cowork` plugin from inside the new `lore` plugin — Claude Code doesn't expose that surface.
- Bundling the watcher daemon into the plugin. The watcher's lifecycle (runs when no session is active, needs launchd/systemd integration) is fundamentally different from in-session tooling and belongs in the standalone CLI.

## Architecture

**One plugin, one MCP server, two session sources.**

```
lore/                              # was lore-cowork/
├── .claude-plugin/plugin.json     # name: "lore", version: 1.0.0
├── .mcp.json                      # registers MCP server as "lore-local"
├── commands/
│   ├── share.md                   # calls share_session MCP tool
│   └── lore.md                    # calls get/list/search_threads
├── server/lore-mcp                # built binary (renamed from lore-cowork-mcp)
└── server-src/
    ├── index.ts
    ├── lib/
    │   ├── session/               # NEW: SessionSource abstraction
    │   │   ├── index.ts           # detectSource() factory + interface
    │   │   ├── claudeCode.ts      # NEW
    │   │   └── cowork.ts          # existing lib/session.ts, moved
    │   ├── auth/                  # NEW: replaces tokens.ts + refresh.ts
    │   │   ├── discovery.ts       # PRM + AS metadata fetch
    │   │   ├── deviceFlow.ts      # AuthKit device-code login
    │   │   ├── refresh.ts         # mutex-guarded refresh
    │   │   └── store.ts           # ~/.lore/tokens.json read/write
    │   ├── cloudCall.ts           # unchanged
    │   └── errors.ts              # unchanged
    └── tools/                     # handlers swap to SessionSource + auth/
```

The MCP server detects its runtime once at startup: `CLAUDE_SESSION_ID` present → `ClaudeCodeSource`, otherwise → `CoworkSource`. Every tool that touches local sessions (`share_session`, `list_local_sessions`, `read_local_session`) routes through the source interface and stays runtime-agnostic.

Everything cloud-touching — auth, `share_session` upload, thread reads — is already runtime-agnostic via `callCloudTool` posting JSON-RPC envelopes to `https://mcp.lore.tanagram.ai/mcp`. The hosted MCP doesn't know or care which runtime the transcript bytes came from.

## SessionSource abstraction

```ts
// lib/session/index.ts
export interface SessionSource {
  /** Human label for error messages. */
  readonly runtime: 'claude-code' | 'cowork';

  /** Resolve the active session id. Throws NoActiveSession if none. */
  resolveActiveId(env: NodeJS.ProcessEnv): Promise<string>;

  /** List all sessions on disk, newest first. */
  listSessions(): Promise<SessionSummary[]>;

  /** Read a session's transcript + metadata by id. */
  readSession(id: string): Promise<SessionPayload>;
}

export function detectSource(env = process.env): SessionSource {
  if (nonBlank(env.CLAUDE_SESSION_ID)) return new ClaudeCodeSource();
  return new CoworkSource();
}
```

`SessionPayload` is the same shape both sources produce — `{ id, transcript: string, uploads: [...], outputs: [...], modifiedAt }` — so tool handlers don't branch.

**CoworkSource** = existing `lib/session.ts` moved verbatim. Reads `local_*/audit.jsonl` from the Cowork sessions directory, uses `COWORK_SESSION_ID` env or mtime fallback. Zero behavior change.

**ClaudeCodeSource** = new. Locates `~/.claude/projects/<encoded-cwd>/` (encoding: replace `/` with `-`), lists `<uuid>.jsonl` files, uses `CLAUDE_SESSION_ID` for active-session resolution. Transcript parsing is simpler than Cowork — Claude Code's JSONL is already the canonical format the hosted MCP expects, no `audit.jsonl` repacking needed.

**Tool handler swap.** Today's `share_session.ts` hardcodes `readSession` from `lib/session.ts`; the change is mechanical — swap the import for `detectSource().readSession()`. Tests pass an injected `SessionSource` directly, so the existing `{ env: {...} }` test pattern stays, just one level up.

### Runtime detection rules

- `CLAUDE_SESSION_ID` non-blank → `ClaudeCodeSource`.
- Otherwise → `CoworkSource`.
- `COWORK_SESSION_ID` is **only** read by `CoworkSource` for active-session resolution. It does not affect runtime detection.

These envs are mutually exclusive in practice — you're never running inside both runtimes simultaneously.

### `process.cwd()` contract

`ClaudeCodeSource` derives the project directory from `process.cwd()` to look up `~/.claude/projects/<encoded-cwd>/`. The MCP server's cwd is inherited from whoever spawns it (Claude Code's stdio launcher). This contract is currently satisfied but worth a code comment — if Claude Code ever changes how it launches MCP processes, the source will need updating.

## WorkOS AuthKit migration

### Current state (pre-merge)

Plugin uses a custom OAuth 2.0 device-code flow:
- `POST /oauth/device/code` and `POST /oauth/token` against Tanagram's own endpoints.
- Hardcoded `CLIENT_ID = loremcp_…`, hardcoded `SCOPE = "mcp.read mcp.write"`.
- Tokens stored in `~/.lore/tokens.json`, sent as `Bearer` to `/mcp`.

### Target state (post-merge, post-#596)

- `/mcp` validates WorkOS AuthKit-issued JWTs: issuer = `WORKOS_AUTHKIT_DOMAIN`, audience = `LORE_OAUTH_AUDIENCE`, `org_id` claim required and must match an active workspace membership.
- PRM (`/.well-known/oauth-protected-resource`) advertises `authorization_servers: [WORKOS_AUTHKIT_DOMAIN]`.
- Scope gating gone — audience check is the security boundary.
- Legacy `/oauth/*` endpoints removed (after #596).

### Plugin-side changes

1. **Discovery, not hardcoding.** On first auth, fetch `https://mcp.lore.tanagram.ai/.well-known/oauth-protected-resource` → read `authorization_servers[0]` → fetch that AS's `/.well-known/oauth-authorization-server` for the device-authorization endpoint, token endpoint, and JWKS URI. Cache the result keyed by the cloud base URL.

2. **New client registration.** Need an AuthKit-issued `client_id` for the plugin. Public client (no secret), device flow enabled. One per plugin, not per user.

3. **Token request shape.** Standard OIDC scopes: `openid email profile offline_access`. Drop `mcp.read` / `mcp.write`. Pass `audience=<LORE_OAUTH_AUDIENCE>` on the device-code initiation — this is the critical parameter that makes the resulting JWT acceptable to the hosted `/mcp`.

4. **Refresh.** Same RFC flow against AuthKit's token endpoint. Module-scope mutex (existing `inFlight` pattern in `lib/refresh.ts`) carries over.

5. **Token storage.** Same `~/.lore/tokens.json` shape works. The JWT is opaque to the plugin — local verification is not the plugin's job; the hosted `/mcp` is the verifier.

6. **Migration of existing tokens.** Old `~/.lore/tokens.json` from the legacy flow will fail the audience check at `/mcp`. On 401, the existing `deleteTokens` + `AuthRequiredError` path triggers re-auth via AuthKit. No special migration code needed — the natural failure path handles it.

## Migration of existing users

### `lore` plugin users

The old `lore` plugin shipped slash commands that shell out to the npm CLI. The new merged plugin ships slash commands **plus** an MCP server. On update:
- Claude Code registers the new MCP server on next launch.
- User authenticates once via the new AuthKit flow (the CLI's `~/.lore/tokens.json` won't pass the audience check).
- Slash command names stay (`/share`, `/lore`), so muscle memory is preserved.

README gets an "Upgrading from 0.x" section: "Run `/share` once, follow the OAuth prompt to authenticate."

### `lore-cowork` plugin users

We publish a final `lore-cowork@1.0.0` whose only change is a README that reads:

> This plugin has been renamed and merged with `lore`. Please run `/plugin uninstall lore-cowork && /plugin install lore`.

The new `lore` plugin, on its first `/share`, can detect that the legacy `lore-cowork` MCP server is also registered and emit a one-time warning prompting the user to uninstall it.

### Marketplace

`.claude-plugin/marketplace.json` advertises only `lore`. New installers see the canonical plugin. Existing `lore-cowork` users have their installed copy work until they update, at which point the deprecation README guides them over.

## CLI soft-prompt (discoverability for the watcher)

After a successful `/share`, the command handler appends a one-liner — but not every time, or it becomes noise. Heuristic: show on the user's first 3 successful shares, then never again unless they reset.

State tracked in `~/.lore/plugin-state.json`:
```json
{ "share_count": 2, "watcher_prompt_dismissed": false }
```

Text appended to `/share` output:
> Tip: install `@tanagram/lore` (`npm i -g @tanagram/lore`) to auto-share new sessions in the background. Run `lore watch --help` to learn more.

This file is plugin-owned, separate from `tokens.json`. Manually deleting it resets the counter.

## Repo layout after merge

```
.claude-plugin/marketplace.json    # advertises only `lore`
lore/                              # was lore-cowork/
├── .claude-plugin/plugin.json
├── .mcp.json
├── commands/
├── scripts/build.sh
├── server/lore-mcp
└── server-src/
docs/plans/
└── 2026-05-18-merge-lore-and-lore-cowork-design.md
```

The pre-merge `lore/` directory is deleted. The pre-merge `lore-cowork/` directory is renamed to `lore/`. The GitHub remote stays `tanagram/lore-plugin`.

## Versioning

- `lore@0.x` → `lore@1.0.0` (breaking: adds MCP server, drops CLI bootstrap, new auth).
- `lore-cowork@0.2.0` → `lore-cowork@1.0.0` (deprecation-only release with README pointing at `lore`).

## Risks and open questions

- **AuthKit client registration ownership.** Who owns the `client_id` and where does it live (committed to the plugin source as a public client identifier, or fetched from a config endpoint)? Default: committed to source, since public OAuth clients are by definition non-secret.

- **AuthKit endpoint discovery caching.** If we cache the discovered endpoints indefinitely and AuthKit changes them, plugins go stale. Default: cache for 24 hours with `If-None-Match` revalidation, fall back to last known good on network failure.

- **Audience parameter delivery.** AuthKit accepts `audience` on the authorization request and propagates it to the JWT. Confirm during implementation that the device-code initiation accepts and honors it — this is the most likely "worked in dev, broke in prod" footgun. Integration test required.

- **Cowork → Claude Code session-format drift.** If Claude Code ever changes its on-disk transcript format, the `ClaudeCodeSource` parser breaks. Mitigation: keep the parser narrowly focused on the JSONL fields the hosted MCP actually consumes, ignore unknown fields rather than schema-validating.

## Test strategy (sketch)

- **Unit:** `SessionSource` implementations get parity tests — same input shapes, same assertions, just different on-disk fixtures.
- **Unit:** Auth discovery + AuthKit device flow mocked at `fetchImpl` level (existing pattern in `tokens.test.ts`).
- **Integration:** End-to-end test against a staging hosted MCP — fresh install → device login → `share_session` → `get_thread`. Run for both `CLAUDE_SESSION_ID` and `COWORK_SESSION_ID` envs.
- **Migration:** Test that a `~/.lore/tokens.json` minted by the legacy flow correctly triggers re-auth on 401 (no infinite loops, no token leakage to logs).

## Execution phases

A separate execution plan will break this into PRs. Likely shape:

1. **SessionSource refactor.** Pure refactor of existing Cowork logic behind the new interface. No behavior change. Lands on `lore-cowork` plugin first to de-risk.
2. **ClaudeCodeSource.** New code, fully tested against Claude Code fixtures, gated behind `CLAUDE_SESSION_ID`.
3. **AuthKit migration.** Replace `tokens.ts` + `refresh.ts` + `lore_login*` tools with the new auth/ subdirectory. Discovery + device flow + audience param. Most-risky phase; deserves its own PR.
4. **Rename + marketplace cutover.** Rename plugin to `lore`, update `.mcp.json` server name, update marketplace.json, publish `lore@1.0.0`, publish `lore-cowork@1.0.0` deprecation release.
5. **Soft-prompt + state file.** Add `plugin-state.json` and the 3-shot watcher prompt to `/share`.
