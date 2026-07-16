# server-src invariants

## 1. Consent precedes the persistent agent

**Banned pattern:** any `spawn` / `exec` / `child_process` / launchd / plist install invocation that can run before explicit consent is recorded.

**Allowed exceptions:** the Task-5 install entry in `tools/lore_consent.ts` (`beginBackgroundAgentInstall`), which may only be called after `writePluginState({ …, consent: 'consented' })`; post-install control-plane CLI calls from `tools/lore_configure.ts` (via `lib/uploadAllowlist.ts`), and future control-plane tools when plugin state is `installed | idle | capturing`.

**Why:** the background agent must never be installed without explicit user opt-in — see design doc `docs/plans/2026-05-31-plugin-consent-surface-design.md`.

**Do:**
```ts
await writePluginState({ ...state, consent: 'consented' }, opts.home);
beginBackgroundAgentInstall({ home: opts.home }); // called only after consent write
readCaptureAllowlist(); // control-plane CLI call, only after installed / idle / capturing state
```

**Don't:**
```ts
beginBackgroundAgentInstall(); // no prior consent check
```

## 2. The plugin works install-free

**Banned pattern:** routing reads / `lore_login` / `lore_login_resume` / manual `share_session` through a shelled CLI binary, or reading `PluginState.consent` from the MCP dispatcher to gate ordinary tool calls.

**Allowed exceptions:** `tools/lore_consent.ts` and post-install background-capture control-plane tools may inspect consent; ordinary tools must always run regardless of CLI install state.

**Why:** auth and manual sharing must work before (and without) the CLI being installed — see ADR-0002 `docs/adr/0002-plugin-cli-two-clients-one-contract.md`.

**Do:**
```ts
// lore_login: calls cloudCall() directly; no CLI dependency
export const loreLoginTool: ToolDefinition = { … handler: () => cloudCall(…) };
```

**Don't:**
```ts
// Do NOT shell out to the CLI for reads/auth/manual share
execSync('lore-mcp share …');
// Do NOT gate ordinary MCP tools on background-capture consent
if (state.consent === 'unconsented') return buildConsentSurface(); // wrong
```

## 3. No inline `{ type: 'resource' }` blocks in tool results

**Banned pattern:** a `CallToolResult.content` element with `type: 'resource'` (inline mcp-ui block) in result-construction code.

**Allowed exception:** none in result construction; test assertions verifying its absence are allowed.

**Why:** ADR-0011 rejected inline mcp-ui in favor of MCP Apps; ADR-0012 dropped the iframe surface entirely on host-availability grounds, but the inline-mcp-ui rejection stands — a future iframe surface goes through a registered `ui://` resource, not an inline block. See `docs/adr/0011-consent-ui-mcp-apps-not-inline-mcp-ui.md` (origin) and `docs/adr/0012-consent-surface-text-only.md` (current).

**Do:**
```ts
return { content: [{ type: 'text', text }], structuredContent: { consent } };
```

**Don't:**
```ts
return { content: [{ type: 'resource', resource: { uri: 'ui://lore/consent', mimeType: 'text/html', text: html } }] };
```
