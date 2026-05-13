# Lore — Claude Cowork plugin

Share your Cowork session to [Lore](https://lore.tanagram.ai) and read threads back, without leaving the agent.

## Install

In Claude Cowork:

```
/plugin marketplace add tanagram/lore-plugin
/plugin install lore-cowork@tanagram
```

## What you get

- **`/share`** — post the current Cowork session to Lore. Returns a shareable URL, plus a brief note if your session included uploaded or generated files. Visibility is private in v1; re-share from the Lore web UI to make a thread workspace-visible.
- **`/lore`** — fetch a Lore thread by ID or URL, or list and search threads by title.

Natural-language phrasings work too — "share this", "send this to my team", "show me that Lore thread `th_...`" — because Cowork surfaces the plugin's tool descriptions to the agent on every turn.

## First-time setup

The first time you run `/share` or `/lore`, Cowork pops a browser to [lore.tanagram.ai](https://lore.tanagram.ai). Sign in via WorkOS, pick a workspace, click Allow. Cowork caches the access and refresh tokens and silently refreshes them — subsequent calls are zero-friction. There's no CLI to install and no token file to manage.

## Architecture

The plugin registers two MCP servers: a bundled stdio binary that reads your local Cowork session bytes off disk (the only path out of the agent's sandbox to `audit.jsonl`), and the cloud Lore MCP at `https://lore.tanagram.ai/mcp` which handles upload, thread fetching, and search. The stdio binary is a Bun-compiled single executable. OAuth is handled entirely by Cowork against the cloud MCP's standard OAuth 2.1 endpoints — this plugin does no auth itself. See [`DESIGN.md`](./DESIGN.md) for the full breakdown.

## Requirements

macOS arm64 only for v1. The plugin ships a precompiled Bun binary for Apple Silicon — Intel Macs and Linux are out of scope for now.

## License

MIT
