# Plugin server invariants

- **The plugin has no capture control plane.** Do not configure, install, enable, disable, inspect, or otherwise manage background capture from plugin code. Do not shell out to the Lore CLI for capture behavior. Desktop owns embedded capture; the interactive CLI owns standalone configuration and background-agent lifecycle. See ADR-0015.
- **Ordinary tools are install-free.** Do not route auth, cloud reads/search, local session reads, or manual `share_session` through the Lore CLI.
- **Tool results contain no inline resources.** Do not return `CallToolResult.content[*].type === 'resource'`; tests/adapter fixtures may prove rejection or text conversion. Current focused tests cover known paths, not every future result boundary. See ADR-0012.
