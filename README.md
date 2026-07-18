# Lore Agent Harness Plugins

This repo contains skills for sharing and working with [Lore threads](https://lore.link). The skills are distributed as plugins for Claude Code, Cowork, Codex, and Amp. See how to [share Claude Code sessions with your team](https://lore.link/share).

See [the docs](https://lore.link/docs/using-lore) for more details.

## Install

### Claude Code

From a plain terminal (outside a session), run the following commands:

```bash
claude plugin marketplace add loredotlink/lore-plugin
claude plugin install plugin@loredotlink
```

### Codex

Codex uses the same shared package through [`.agents/plugins/marketplace.json`](./.agents/plugins/marketplace.json).

### Amp

[Amp](https://ampcode.com/) does not use the Claude/Codex manifests. Amp loads TypeScript plugins from local files:

- Project plugin: `.amp/plugins/*.ts`
- System plugin: `~/.config/amp/plugins/*.ts`

Use the script below to clone this repo and symlink the Amp plugin into a location that Amp will recognize:

```bash
if [ -d ~/.local/share/lore-plugin/.git ]; then
  git -C ~/.local/share/lore-plugin pull --ff-only
else
  git clone https://github.com/loredotlink/lore-plugin ~/.local/share/lore-plugin
fi

cd ~/.local/share/lore-plugin
bun install --frozen-lockfile

mkdir -p ~/.config/amp/plugins
ln -sf ~/.local/share/lore-plugin/amp/lore.ts ~/.config/amp/plugins/lore.ts

amp plugins list
```

Then reload plugins from Amp's command palette with `plugins: reload`. The command palette should show **Lore: Share active Amp thread**. `amp plugins list` should include:

```text
✓ /Users/.../.config/amp/plugins/lore.ts active
  Command: Lore: Share active Amp thread
  Tool: share_current_amp_thread
  Tool: lore_login
  Tool: lore_login_resume
  Tool: get_thread
  Tool: list_threads
  Tool: search_threads
  Tool: fork_thread
```

## What you get

- **`/lore:share`** — uploads the current session to Lore, and returns a shareable URL.
- **`/lore:fork`** — distill an existing Lore thread into intent-conditioned handoff context for continuing work.
- **`/lore:read`** / read tools — fetch a Lore thread by ID or URL, or list and search threads by title.
- **`Lore: Share active Amp thread`** — in Amp, export the active Amp thread with the local Amp CLI, upload the raw export to Lore as `harness: 'amp'`, and return the Lore URL for that session.
- **`share_current_amp_thread`** — an Amp tool for explicit natural-language invocation. It accepts `{ thread_id?: string, visibility?: 'private' | 'workspace' | 'public', highlight?: string }`; if `thread_id` is omitted, `AMP_CURRENT_THREAD_ID` must be set or the tool returns an actionable error. `highlight` is a natural-language description of the block or block range to emphasize in the returned Lore URL.

In Claude Code, Cowork, and Codex, you can also share to Lore using natural language (e.g. "share this session to Lore").

When you share a thread, you can also specify specific blocks that should be highlighted (e.g. "share the final outcome of this investigation"). Lore resolves the description against parsed thread blocks and returns a `thread_url` with corresponding anchor tags when it finds a confident match. If highlight resolution fails or times out, sharing still succeeds and returns the base thread URL without anchor tags.

## First-time setup

The first time you use `/lore:share`, `/lore:read`, or the Amp share/read tools, the plugin's `lore_login` tool opens a browser kick off a login flow. The plugin persists an auth and refresh token in the `~/.lore/tokens.json` file (mode 0600). If the browser cannot be opened automatically (SSH or other environments without a GUI), `lore_login` returns a `verification_uri` + `device_code` and the agent calls `lore_login_resume` once you complete the flow on another device.

## Architecture

The shared package contains host-specific manifests for Claude Code and Codex, an Amp TypeScript plugin entrypoint, one bundled stdio MCP server that reads Claude/Cowork/Codex local session bytes off disk, and the proxy/auth code that talks to the Lore cloud MCP at `https://mcp.lore.link/mcp`. The stdio binary is a Bun-compiled single executable. Auth runs in-process via the `lib/auth/` library, with shared token storage, legacy migration, OAuth discovery, and refresh logic delegated to `@lore/identity-store`: RFC 8628 device-code flow against WorkOS AuthKit, discovery-driven (PRM → AS metadata, cached at `~/.lore/discovery-cache.json`), with silent refresh and 401-triggered re-login. See [`DESIGN.md`](./DESIGN.md) for the full breakdown.

This repo is a mirrored subtree from our internal monorepo.

## Requirements and limitations

- macOS arm64 only for the packaged stdio MCP binary in v1. The plugin ships a precompiled Bun binary for Apple Silicon — Intel Macs and Linux are out of scope for now.
- Amp sharing requires the local `amp` CLI to be installed and able to run `amp threads export <thread_id>`.
- Amp installation is local file-based for now. Do not assume an Amp marketplace distribution exists.
- Amp active-thread sharing is command-palette based. Natural-language sharing is available through the explicit `share_current_amp_thread` tool when a thread ID is supplied or `AMP_CURRENT_THREAD_ID` is present; automatic agent-context injection may come later.

## License

Licensed under the [Functional Source License, Version 1.1, ALv2 Future License (FSL-1.1-ALv2)](./LICENSE).
