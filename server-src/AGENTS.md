# server-src invariants

## 1. Consent precedes the persistent agent

**Banned pattern:** any `spawn` / `exec` / `child_process` / launchd / plist install invocation not guarded by a `consent === 'consented'` check.

**Allowed exception:** the Task-5 install entry in `tools/lore_consent.ts` (`beginBackgroundAgentInstall`), which may only be called after `writePluginState({ …, consent: 'consented' })`.

**Why:** the background agent must never be installed without explicit user opt-in — see design doc `docs/plans/2026-05-31-plugin-consent-surface-design.md`.

**Do:**
```ts
await writePluginState({ ...state, consent: 'consented' }, opts.home);
beginBackgroundAgentInstall({ home: opts.home }); // called only after consent write
```

**Don't:**
```ts
beginBackgroundAgentInstall(); // no prior consent check
```

## 2. The plugin works install-free

**Banned pattern:** routing reads / `lore_login` / `lore_login_resume` / manual `share_session` through a shelled CLI binary, or adding those tool names to the consent gate (i.e. removing them from `CONSENT_GATE_EXEMPT` or adding them to a new gate).

**Allowed exception:** none — these tools must always proxy to the hosted MCP via `lib/cloudCall.ts` regardless of CLI install state.

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
// Do NOT add lore_login* to a gate
const GATE = new Set(['share_session', 'lore_login']); // wrong
```

## 3. No inline `{ type: 'resource' }` blocks in tool results

**Banned pattern:** a `CallToolResult.content` element with `type: 'resource'` (inline mcp-ui block) in result-construction code.

**Allowed exception:** none in result construction; test assertions verifying its absence are allowed.

**Why:** ADR-0006 rejected inline mcp-ui in favor of MCP Apps; ADR-0007 dropped the iframe surface entirely on host-availability grounds, but the inline-mcp-ui rejection stands — a future iframe surface goes through a registered `ui://` resource, not an inline block. See `docs/adr/0006-consent-ui-mcp-apps-not-inline-mcp-ui.md` (origin) and `docs/adr/0007-consent-surface-text-only.md` (current).

**Do:**
```ts
return { content: [{ type: 'text', text }], structuredContent: { consent, macSupported } };
```

**Don't:**
```ts
return { content: [{ type: 'resource', resource: { uri: 'ui://lore/consent', mimeType: 'text/html', text: html } }] };
```
