# Plugin Context

The Lore plugin is the **discovery front door** and a manual-share and consumption surface. It authenticates users, reads local sessions for explicit actions, manually shares sessions, and reads Lore cloud data. It does not configure, install, enable, disable, inspect, or perform background capture.

Capture setup belongs outside the plugin: the desktop app owns its embedded capture process and configuration UI, while the interactive CLI owns standalone configuration and background-agent lifecycle (see [`apps/cli/CONTEXT.md`](../../apps/cli/CONTEXT.md)). The plugin does not shell out to the CLI for capture operations.

## Language

**Front door**:
The *discovery/distribution* entry point — how most users first meet Lore, installed cross-host via a host's plugin manager. "Front door" means the primary discovery path, **not** the only door: CLI-direct install (`npm i -g @loredotlink/cli`) remains a first-class entrance that shares Lore identity and server contracts.
_Avoid_: "only door", "sole install path".

**Manual share**:
An explicit user request to upload a selected local session or Amp thread. Manual sharing is plugin-owned and is independent of background capture configuration.
_Avoid_: capture, watcher.

**Capture control plane**:
Configuration and lifecycle operations for automatic capture. Desktop owns these for its embedded process; the CLI owns them for the standalone background agent. The plugin owns none of them.
_Avoid_: describing the plugin as a capture client or configuration surface.

**Consumption**:
The authenticated cloud operations that list, get, fork, and search threads. The plugin serves these directly; they do not route through the CLI.
_Avoid_: using "consumption" for configuration or capture.
