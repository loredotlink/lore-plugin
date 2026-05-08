# Lore — Claude Code plugin

Share your Claude Code sessions to [Lore](https://lore.tanagram.ai) and read threads back, without leaving the terminal.

## Install

In Claude Code:

```
/plugin marketplace add tanagram-ai/lore-plugin
/plugin install lore@tanagram-ai-lore-plugin
```

That's it. The first time you run `/share` or `/lore`, the plugin will install the `@tanagram/lore` CLI globally via `npm install -g @tanagram/lore`. Requires Node.js 18+.

## What you get

- **`/share`** — export the current session to Lore. Returns a shareable URL (copied to clipboard on macOS/Linux/Windows when a clipboard tool is available). Defaults to workspace visibility; ask for "publicly" or "privately" to override.
- **`/lore`** — fetch a Lore thread by ID/URL, or list/search threads (by author, filepath prefix, time range).

Both commands also work via natural language ("share this", "show me that Lore thread `th_...`").

## First-time setup

After install, run `tanagram login` in your terminal once to authenticate. The plugin will remind you if you forget.

## License

MIT
