# Lore — Claude Code plugin

Share your Claude Code sessions to [Lore](https://lore.tanagram.ai) and read threads back, without leaving the terminal.

## Install

In Claude Code:

```
/plugin marketplace add tanagram/lore-plugin
/plugin install lore@tanagram
```

That's it. The first time you run `/share` or `/lore`, the plugin will install the `@tanagram/lore` CLI globally via `npm install -g @tanagram/lore`. Requires Node.js 18+.

## What you get

- **`/share`** — export the current session to Lore. Returns a shareable URL (copied to clipboard on macOS/Linux/Windows when a clipboard tool is available). Defaults to workspace visibility; ask for "publicly" or "privately" to override.
- **`/lore`** — fetch a Lore thread by ID/URL, or list/search threads (by author, filepath prefix, time range).

After the CLI installs, you also get the full `share` and `lore-read` skills registered globally (from `@tanagram/lore`'s install hook) — so natural-language phrasings like "share this" or "show me that Lore thread `th_...`" work too.

## Architecture

This plugin is a thin shim. It ships only the slash commands; the underlying skills, agents, and CLI all live in [`@tanagram/lore`](https://www.npmjs.com/package/@tanagram/lore). The plugin's job is to be discoverable from inside Claude Code (`/plugin`) and bootstrap the CLI on first use.

## First-time setup

After install, run `tanagram login` in your terminal once to authenticate. The plugin will remind you if you forget.

## License

MIT
