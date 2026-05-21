# Lore plugin

Share your Claude Code, Cowork, or Codex session to [Lore](https://lore.tanagram.ai) and read threads back, without leaving the agent.

## Install

```
/plugin marketplace add tanagram/lore-plugin
/plugin install lore@tanagram
```

Codex uses the same shared package through [`.agents/plugins/marketplace.json`](../.agents/plugins/marketplace.json).

## What you get

- **`share`** — post the current local session to Lore. Returns a shareable URL, plus a brief note if your session included uploaded or generated files. Visibility is private in v1; re-share from the Lore web UI to make a thread workspace-visible.
- **`lore`** — fetch a Lore thread by ID or URL, or list and search threads by title.

Natural-language phrasings work too — "share this", "send this to my team", "show me that Lore thread `th_...`" — because the host agent surfaces the plugin's tools and skills on every turn. Claude Code may also expose host-native command affordances, but the package itself is organized around shared `skills/`.

## First-time setup

The first time you use `share` or `lore`, the plugin's `lore_login` tool opens a browser to the WorkOS AuthKit consent screen with a device code pre-filled. Sign in, click Allow, and the tool returns. The plugin persists tokens under `~/Library/Application Support/tanagram/lore/tokens.json` (mode 0600) and refreshes them silently on subsequent calls. If the browser cannot be opened automatically (SSH, no GUI), `lore_login` returns a `verification_uri` + `device_code` and the agent calls `lore_login_resume` once you complete the flow on another device.

## Architecture

The shared package contains host-specific manifests for Claude Code and Codex, one bundled stdio MCP server that reads your local session bytes off disk, and the proxy/auth code that talks to the Lore cloud MCP at `https://lore.tanagram.ai/mcp`. The stdio binary is a Bun-compiled single executable. Auth runs in-process via the `lib/auth/` library: RFC 8628 device-code flow against WorkOS AuthKit, discovery-driven (PRM → AS metadata, cached at `~/Library/Application Support/tanagram/lore/discovery-cache.json`), with silent refresh and 401-triggered re-login. See [`DESIGN.md`](./DESIGN.md) for the full breakdown.

The human-facing prompts now live under [`skills/`](./skills) rather than a separate `commands/` tree so the package layout is shared across agents.

## Requirements

macOS arm64 only for v1. The plugin ships a precompiled Bun binary for Apple Silicon — Intel Macs and Linux are out of scope for now.

## License

MIT
