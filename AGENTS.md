# Lore plugin invariants

## Plugin changes require reviewed version bumps

- **Banned pattern:** PR changes under `packages/lore-plugin/` without increasing `version` in `package.json`, `.claude-plugin/plugin.json`, and `.codex-plugin/plugin.json`.
- **Allowed exceptions:** PRs that only touch those three version manifest files.
- **Why:** the monorepo is the plugin source of truth, and distribution changes must land through protected PRs with an explicit reviewed version bump.
- **Enforced by:** `.github/workflows/lore-plugin-version-check.yml` via `scripts/check-lore-plugin-version-bump.mjs`.

## Cloud MCP tools are generated from shared specs

- **Banned pattern:** new hand-written `server-src/tools/get_thread.ts`, `server-src/tools/list_threads.ts`, `server-src/tools/search_threads.ts`, or duplicated `inputSchema`/`description` for cloud-owned tools.
- **Allowed exceptions:** `server-src/tools/cloudProxyTools.ts` and `server-src/tools/share_session.ts` for the plugin-local wrapper.
- **Why:** `@lore/contracts/mcp` is the source of truth for public MCP tool metadata; the plugin only adds local stdio/auth/proxy behavior.
- **Enforced by:** `server-src/tools/cloudProxyTools.test.ts` and `server-src/tools/index.test.ts`.
- **Do / don't:** do `import { cloudProxyTools } from './cloudProxyTools.js'`; don't add `export const getThreadTool = { name: 'get_thread', inputSchema: { ... } }`.
