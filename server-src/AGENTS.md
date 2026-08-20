# Plugin server invariants

- **The plugin has no capture control plane.** Do not configure, install, enable, disable, inspect, or otherwise manage background capture from plugin code. Desktop owns capture configuration and lifecycle. See ADR-0015.
- **Ordinary tools are install-free.** Keep auth, cloud reads/search, local session reads, and manual `share_session` self-contained.
- **Tool results contain no inline resources.** Do not return `CallToolResult.content[*].type === 'resource'`; tests/adapter fixtures may prove rejection or text conversion. Current focused tests cover known paths, not every future result boundary. See ADR-0012.
