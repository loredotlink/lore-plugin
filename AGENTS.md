# Lore plugin invariants

- Plugin content changes require a greater, matching version in `package.json`, `.claude-plugin/plugin.json`, and `.codex-plugin/plugin.json`. Manifest-only synchronization must still leave all three equal. Enforced by `scripts/check-lore-plugin-version-bump.mjs` in `.github/workflows/lore-plugin-version-check.yml`.
- Cloud-owned tools (`list_threads`, `get_thread`, `fork_thread`, `search_threads`) are generated in `server-src/tools/cloudProxyTools.ts` from `@lore/contracts/mcp`; `share_session` is the local-wrapper exception. `cloudProxyTools.test.ts` and `tools/index.test.ts` provide partial enforcement.
- Changes under `server-src/**` are built and smoke-tested by `.github/workflows/lore-plugin-binary-drift.yml`.

For server behavior, follow `server-src/AGENTS.md`.
