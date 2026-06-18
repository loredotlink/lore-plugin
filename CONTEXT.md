# Plugin Context

The Lore plugin is the **discovery front door** and the consume/configure surface. It does not capture — capture is the CLI's job (see [`apps/cli/CONTEXT.md`](../../apps/cli/CONTEXT.md)). The plugin and CLI are two clients of one server contract, not a binary that shells into the other.

## Language

**Front door**:
The *discovery/distribution* entry point — how most users first meet Lore, installed cross-host via a host's plugin manager. "Front door" means the primary discovery path, **not** the only door: CLI-direct install (`npm i -g @loredotlink/cli`) remains a first-class entrance that converges on the same engine and config.
_Avoid_: "only door", "sole install path".

**MCP App**:
The MCP-UI config/consent surface the plugin opens on first use, where a user consents to install the background agent and picks allowlist entries. Progressive enhancement: falls back to a web page, then to the CLI `configure` wizard, depending on host capability.
_Avoid_: Settings panel, dashboard.

**Control plane**:
The configure / capture / status operations. The CLI owns these; the plugin delegates to the CLI (post-install) rather than reimplementing them.
_Avoid_: using "control plane" for read/consumption.

**Data plane**:
The read/consumption operations (list, get, search threads). The plugin serves these directly via authenticated cloud calls; they do not route through the CLI.
_Avoid_: using "data plane" for configuration or capture.
