# Plugin server invariants

- **Persistent capture requires recorded consent.** Persist `PluginState.consent = 'consented'` before installing/enabling the background agent. Disabling and post-install control-plane calls are exempt. Covered by `tools/lore_consent.test.ts`; write-before-install ordering remains review-enforced.
- **Ordinary tools are install-free.** Do not route auth, cloud reads/search, local session reads, or manual `share_session` through the Lore CLI, and do not gate the MCP dispatcher on capture consent. `lore_consent`, `lore_configure`, and post-install capture controls are exempt. Covered in part by `index.test.ts`.
- **Tool results contain no inline resources.** Do not return `CallToolResult.content[*].type === 'resource'`; tests/adapter fixtures may prove rejection or text conversion. Current focused tests cover known paths, not every future result boundary. See ADR-0012.
