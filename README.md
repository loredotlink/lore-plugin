# Lore plugins

This repo contains the Lore plugin bundles for Claude Code, Codex, and Claude Cowork.

## Install

### Claude Code

In Claude Code:

```
/plugin marketplace add tanagram/lore-plugin
/plugin install lore@tanagram
```

That's it. The first time you run `/share` or `/lore`, the plugin will install the `@tanagram/lore` CLI globally via `npm install -g @tanagram/lore`. Requires Node.js 18+.

### Codex

The Codex plugin bundle lives at [`plugins/lore`](./plugins/lore), with its marketplace metadata at [`.agents/plugins/marketplace.json`](./.agents/plugins/marketplace.json). It provides two Codex-native skills:

- `share-codex` — share the current Codex rollout to Lore.
- `lore-read` — fetch or search Lore threads from Codex.

Like the Claude Code plugin, it is a thin shim over `@tanagram/lore` and bootstraps the CLI on first use.

## What you get

- **`/share`** — export the current session to Lore. Returns a shareable URL (copied to clipboard on macOS/Linux/Windows when a clipboard tool is available). Defaults to workspace visibility; ask for "publicly" or "privately" to override.
- **`/lore`** — fetch a Lore thread by ID/URL, or list/search threads (by author, filepath prefix, time range).

After the CLI installs, you also get the full `share` and `lore-read` skills registered globally (from `@tanagram/lore`'s install hook) — so natural-language phrasings like "share this" or "show me that Lore thread `th_...`" work too.

## Architecture

These plugins are intentionally thin shims. The Claude Code bundle ships slash commands, the Codex bundle ships skills, and the underlying session-sharing and thread-reading logic lives in [`@tanagram/lore`](https://www.npmjs.com/package/@tanagram/lore). The plugin repo's job is to make Lore discoverable from each agent surface and bootstrap the CLI on first use.

## First-time setup

After install, run `lore login` in your terminal once to authenticate. The plugin will remind you if you forget.

## License

MIT
