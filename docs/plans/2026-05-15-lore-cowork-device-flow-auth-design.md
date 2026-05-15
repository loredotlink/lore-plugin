# lore-cowork: host-proxy OAuth via RFC 8628 device flow

**Status:** Design, v0.1.0 target
**Date:** 2026-05-15
**Repos:** `tanagram/lore` (cloud) + `tanagram/lore-plugin` (this repo, authoritative)

## Background

The `lore-cowork` Cowork plugin ships two MCP servers via `.mcp.json`:

1. `lore-cowork-local` — a stdio server (~1,400 LOC of TS, compiled with Bun to `lore-cowork/server/lore-cowork-mcp`) exposing local session-reading tools.
2. `lore` — a remote HTTP MCP server pointing at `https://mcp.lore.tanagram.ai/mcp`, OAuth-protected (PKCE-S256, RFC 7591 dynamic client registration, refresh-token rotation).

The v0.1.0 DESIGN.md assumed Cowork's built-in `authenticate` / `complete_authentication` tools would drive the OAuth flow for the remote server. **They don't work.** Cowork loses the PKCE verifier between the two calls — three back-to-back fresh flows in a single session all failed identically with `"No OAuth flow is in progress for plugin:lore-cowork:lore"`. The state is held in per-tool-call or per-turn memory and doesn't survive the browser round-trip. Bug filed with Anthropic; no ETA.

## Decision

Remove Cowork from the auth path entirely. The host stdio MCP runs its own RFC 8628 device-flow OAuth via a host-side `lore_login` tool, persists tokens to disk, and **proxies** the four cloud tools (`share_session`, `get_thread`, `list_threads`, `search_threads`) through itself with `Authorization: Bearer <jwt>` headers.

Tool surface visible to the agent expands from 5 (2 local + 3 cloud) to 6 (2 local + 2 auth + 4 cloud proxies). The UX adds one extra tool call (`lore_login`) on first use; all subsequent invocations are invisible.

The remote `lore` MCP entry is removed from `.mcp.json`. Only `lore-cowork-local` remains.

## Architecture

```
Agent (Claude Code / Cowork)
  │
  ▼  JSON-RPC over stdio
lore-cowork-local  (Bun binary)
  ├── read_local_session    (existing, local)
  ├── list_local_sessions   (existing, local)
  ├── lore_login            (new, drives device flow)
  ├── lore_login_resume     (new, headless fallback)
  ├── share_session         (new, proxies to cloud)
  ├── get_thread            (new, proxies to cloud)
  ├── list_threads          (new, proxies to cloud)
  └── search_threads        (new, proxies to cloud)
        │
        ▼  HTTPS, Bearer JWT
mcp.lore.tanagram.ai
  ├── /mcp                  (MCP server, existing)
  ├── /oauth/device/code    (new endpoint)
  ├── /oauth/device         (new consent landing)
  └── /oauth/token          (existing, new device-grant branch)
```

## Cloud-side work (`tanagram/lore`)

Adds RFC 8628 device authorization grant to the existing OAuth 2.1 AS in `apps/api/src/oauth/`. **No WorkOS device-flow delegation** — WorkOS sits behind the consent page as the IdP, exactly as it does today for PKCE. The lore AS owns the device-code state machine and mints its own JWTs (`aud=mcp.lore.tanagram.ai`).

### New table: `lore.oauth_device_codes`

Mirrors `oauth_authorization_codes`. Migration: `packages/db/migrations/YYYYMMDDHHMMSS_oauth_device_codes.sql`, `IF NOT EXISTS`, `lore.` schema prefix per AGENTS.md.

```
id                       typeid 'oauthdevice', pk
device_code_hash         varchar(64), unique-indexed
user_code_hash           varchar(64), unique-indexed
client_id                fk → oauth_clients
scope                    text (space-separated, OAuth convention)
status                   'pending' | 'approved' | 'denied' | 'expired'
user_id                  fk → users, nullable until approved
organization_ids         text[], populated on approval
polling_interval_seconds int default 5
last_polled_at           timestamptz
expires_at               timestamptz
approved_at              timestamptz
consumed_at              timestamptz   -- single-use, flips on first /token call
created_at               timestamptz default now()
```

`user_code` is hashed at rest; raw `XXXX-XXXX` value lives only in the device-authorize response and the `verification_uri_complete` URL.

### Seeded pre-registered client

One row in `oauth_clients`:
```
client_id                     = 'lore-cowork-plugin'
token_endpoint_auth_method    = 'none'    -- public client per RFC 8628 §3.1
scope                         = 'mcp.read mcp.write'
redirect_uris                 = []
```

The plugin binary hardcodes `const CLIENT_ID = 'lore-cowork-plugin'`. No dynamic registration, no client_secret distribution. Refresh-token security comes from rotation, not client authentication.

Verified compatible with existing `oauth_refresh_tokens` schema — lookups are by `tokenHash` (uniquely indexed); `client_id` and `user_id` are independent FKs; many users sharing one client_id works trivially.

### New endpoint files

`apps/api/src/oauth/endpoints/`:

- **`handleOAuthDeviceAuthorize.ts`** — `POST /oauth/device/code`. Validates `client_id` against `oauth_clients`. Generates high-entropy `device_code` and 8-char `user_code` in Crockford base32 minus `I/L/O/U`. Inserts row. Returns `{device_code, user_code, verification_uri, verification_uri_complete, expires_in: 600, interval: 5}`.

- **`handleOAuthDeviceConsent.ts`** — `GET /oauth/device?user_code=XXXX-YYYY`. Hashes the user_code, looks up the pending row. If no session, bounces through existing WorkOS login (`handleOAuthWorkosCallback` already handles this). If authenticated, renders the existing `handleOAuthConsent` UI with `device_code_id` as a hidden input and `scope` from the device row. POST approve marks row `approved` with `user_id` + `organization_ids` from the consent form.

- **Modified `handleOAuthToken.ts`** — new branch for `grant_type=urn:ietf:params:oauth:grant-type:device_code`. Looks up by `device_code_hash`, enforces `slow_down` against `last_polled_at + polling_interval_seconds`, returns `authorization_pending` if pending, `expired_token` if expired, `invalid_grant` for unknown / wrong client_id / already-consumed. On approved: mints JWT and refresh-token using the existing minting helper, leaves `authCodeId` NULL on the refresh row.

### Cleanup

Filter `WHERE expires_at > now()` at query time. No background reaper for v0.1.0 — rows are tiny and bounded. An Inngest cron can be added later.

### Test coverage (~400 LOC)

Mirror existing `apps/api/src/oauth/endpoints/*.test.ts` patterns. New files: `handleOAuthDeviceAuthorize.test.ts`, `handleOAuthDeviceConsent.test.ts`, plus device-grant branch extensions to `handleOAuthToken.test.ts`. Cover: well-formed responses, unknown/malformed inputs, status transitions, slow_down enforcement, single-use semantics, JWT shape, refresh-row schema, CSRF on approve POST.

### Estimate: ~1 day.

## Plugin-side work (`tanagram/lore-plugin`)

All changes in `lore-cowork/server-src/`.

### Layout

```
tools/
  lore_login.ts          ~120 LOC
  lore_login_resume.ts   ~60 LOC
  share_session.ts       ~30 LOC
  get_thread.ts          ~30 LOC
  list_threads.ts        ~30 LOC
  search_threads.ts      ~30 LOC
lib/
  tokens.ts              ~80 LOC
  refresh.ts             ~70 LOC
  cloudCall.ts           ~80 LOC
  errors.ts              ~20 LOC
```

### `lib/tokens.ts`

Persisted at `~/Library/Application Support/tanagram/lore/tokens.json`, mode 0600 on the file, 0700 on the parent directory. Atomic write via write-temp-then-rename. Zod v4 schema validated on read; reject on schema mismatch (fail loud rather than silently re-login). Returns `null` if file missing.

```ts
const TokensSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.number(),  // epoch ms
  scope: z.string(),
});
```

### `lib/refresh.ts`

Exports `getValidAccessToken(): Promise<string>`. The **only** path to a token — every proxy call funnels through this. Implements module-scope mutex to collapse concurrent refresh attempts:

```ts
let inFlight: Promise<string> | null = null;

export async function getValidAccessToken(): Promise<string> {
  if (inFlight) return inFlight;
  inFlight = doGet().finally(() => { inFlight = null; });
  return inFlight;
}
```

`doGet()` reads tokens, returns `access_token` if `expires_at - now() > 30_000`, else POSTs `grant_type=refresh_token`, writes the new pair, returns the new access token. On `invalid_grant`, deletes the file and throws `AuthRequiredError`.

### `lib/cloudCall.ts`

Shared JSON-RPC proxy helper. Builds envelope, attaches `Authorization: Bearer <jwt>`, POSTs to `https://mcp.lore.tanagram.ai/mcp`. On HTTP 401, deletes tokens and throws `AuthRequiredError` (covers server-side revocation between local expiry check and request arrival).

### `lib/errors.ts`

```ts
export class AuthRequiredError extends Error {}

export const AUTH_REQUIRED_MESSAGE =
  'Not authenticated to Lore. Call lore_login first to authenticate, then retry this tool call.';

export function authRequiredToMcpError() {
  return {
    isError: true,
    content: [{ type: 'text', text: AUTH_REQUIRED_MESSAGE }],
  };
}
```

### Proxy tools

Each ~30 LOC — typed args via Zod, one call to `cloudCall`, `AuthRequiredError` mapped to the MCP error result:

```ts
export const share_session = {
  description: 'Share the current Claude Code session to Lore. Requires authentication via lore_login on first use.',
  inputSchema: ShareSessionArgs,
  async handler(args) {
    try {
      return await callCloudTool('share_session', args);
    } catch (e) {
      if (e instanceof AuthRequiredError) return authRequiredToMcpError();
      throw e;
    }
  },
};
```

### `tools/lore_login.ts`

1. POST `/oauth/device/code` with `client_id=lore-cowork-plugin&scope=mcp.read mcp.write`.
2. Shell out: `spawnSync('open', [verification_uri_complete])`.
3. **If `open` exit code === 0:** sync-block polling `/oauth/token` every `interval` seconds. Handle `authorization_pending` (continue), `slow_down` (interval += 5), `expired_token` (return timeout error), success (write tokens file, return `{ok: true}`). Hard cap at `expires_in` seconds.
4. **If `open` exit code !== 0:** return immediately with structured error containing `device_code`, `verification_uri`, `user_code`, and instructions to call `lore_login_resume(device_code)`.

### `tools/lore_login_resume.ts`

Takes `device_code: string`. Sync-block polls `/oauth/token` identically to step 3 above. Used for headless / SSH sessions where browser auto-open failed. Stateless on the plugin side — device_code travels through the agent; server enforces `slow_down` via its own `last_polled_at`.

### `.mcp.json` update

Remove the `lore` server entry. Only `lore-cowork-local` remains.

### `commands/share.md` and `commands/lore.md` updates

Route all tool references through `lore-cowork-local` (no `lore` server prefix).

### Build

`scripts/build.sh` rebuilds the Bun binary. CI's existing drift check enforces source ↔ binary sync. Recommit the rebuilt binary.

### Test coverage (~500 LOC)

Bun test runner, existing `*.test.ts` pattern. Mock the cloud HTTP endpoint with a small in-test server.

- `tokens.test.ts` — atomic write, perms, Zod validation, concurrent reads.
- `refresh.test.ts` — fresh-skip, expired-refresh, invalid_grant-delete, **mutex collapses 10 concurrent refresh calls to one network hit**, error clears inFlight.
- `cloudCall.test.ts` — happy path, 401-deletes-tokens, 5xx-surfaces, malformed-rpc.
- `lore_login.test.ts` — happy path, browser-open failure → resume hint, expired_token, slow_down doubles interval.
- `lore_login_resume.test.ts` — symmetric.
- Each proxy tool: happy path, auth_required-on-no-tokens, auth_required-on-401.

### Estimate: 3-5 days.

## UX flows

| Scenario | Tool calls | User-visible cost |
|---|---|---|
| Cold start (no tokens) | 3: proxy → fail → `lore_login` → proxy | 1 browser click |
| Cold start, headless | 4: proxy → fail → `lore_login` → `lore_login_resume` → proxy | Visit URL from any browser |
| Warm start (valid token) | 1: proxy | Invisible |
| Warm start, expired access token | 1: proxy (refresh internal) | Invisible, +1 cloud round-trip |
| Expired refresh token (~30d) | 3: proxy → fail → `lore_login` → proxy | 1 browser click |
| Server-side revocation | 3: proxy → 401 → `lore_login` → proxy | 1 browser click |
| Authorization timeout (`expired_token`) | Agent retries `lore_login` with fresh device_code | Re-approve |
| Concurrent proxy calls during refresh | N: all parallel (mutex collapses refresh) | Invisible |

## Error contract

Every proxy tool returns one of:
- Success: cloud response passed through.
- `{isError: true, content: [{type: 'text', text: AUTH_REQUIRED_MESSAGE}]}` — agent re-invokes `lore_login`, retries.
- Other errors: passed through verbatim (cloud-level not-found, validation, etc.).

The auth-required message names `lore_login` explicitly. Tool descriptions for all proxy tools mention "Requires authentication via lore_login on first use" so the agent has discovery context up-front.

## Non-goals (v0.1.0)

- **Cowork-driven OAuth.** Even if Anthropic fixes the PKCE state bug, the plugin-driven flow stays canonical.
- **Plugin merge** (`lore` + `lore-cowork`). Follows this work. The device flow is environment-agnostic and is a prerequisite for unifying auth across both plugins.
- **WorkOS-token bridging.** The merged plugin will eventually mint both lore-MCP JWTs and WorkOS session tokens from one login. Out of scope here.
- **Keychain-based token storage.** File with 0600 is sufficient for v0.1.0.
- **Cross-platform binaries.** Mac-arm64 only per DESIGN.md.
- **Multi-window file-lock.** Module-scope mutex covers single-process concurrency. Two windows mid-share simultaneously degrades to one re-auth.
- **Workspace selection on share.** Always private visibility, no `workspace_id` parameter.
- **Granular per-scope consent toggles.** All-or-nothing approval, matches PKCE.
- **Inngest cleanup of `oauth_device_codes`.** Query-time filter for now.
- **Token introspection / `/oauth/userinfo`.** Not needed.

## Sequencing

1. Cloud-side ships first. Plugin can't integration-test without `/oauth/device/code` and the device-grant branch of `/oauth/token`.
2. Plugin-side follows, can be merged behind a feature flag if desired (the only flag-worthy concern is users hitting the new `lore_login` tool before cloud is deployed — unlikely if releases coordinate).
3. Validate end-to-end in a real Claude Code+Cowork session: `lore_login` → `share_session` → restart plugin → `share_session` still works (warm-start path) → wait past 30s for refresh-with-rotation → revoke from web UI → next call recovers via re-login.

## Estimate

~600-900 LOC of new source + ~900 LOC of tests across both repos. ~1 day cloud, ~3-5 days plugin. Serial dependency adds half a day of integration time.
