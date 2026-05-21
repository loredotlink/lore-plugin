# Lore plugins

This repo contains the shared Lore plugin package under [`lore/`](./lore). It is structured to work across Claude Code and Codex, ships a bundled local MCP server, understands Claude Code, Cowork, and Codex session layouts, and talks directly to the Lore cloud MCP.

## Install

### Claude Code

In Claude Code:

```
/plugin marketplace add tanagram/lore-plugin
/plugin install lore@tanagram
```

That's it. The plugin ships its own local stdio binary and authenticates in-place with `lore_login`; there is no separate CLI bootstrap step for the Claude Code plugin.

### Codex

Codex discovers the same shared package under [`lore/`](./lore) via [`.agents/plugins/marketplace.json`](./.agents/plugins/marketplace.json). It uses the same bundled MCP server and the same local-session-read + cloud-share flow as Claude Code.

## What you get

- **`share`** — export the current session to Lore through the local MCP server, without round-tripping transcript bytes through the agent. Returns a shareable URL. Visibility is private in v1; re-share from the Lore web UI if you want a workspace-visible thread.
- **`lore`** — fetch a Lore thread by ID/URL, or list/search threads.

Natural-language phrasings like "share this" or "show me that Lore thread `th_...`" work because the shared package exposes the same Lore tools and skills to each host agent.

## Architecture

The shared package under [`lore/`](./lore) is the implementation for every host: it bundles a local stdio MCP server, runtime-specific session readers, auth flow, cloud proxy tools, and shared prompts in one place. Host-specific manifests live side by side (`.claude-plugin/` and `.codex-plugin/`), while reusable prompts live under `skills/`.

## First-time setup

Authentication happens inside the plugin via `lore_login` the first time you use Lore.

## License

MIT
