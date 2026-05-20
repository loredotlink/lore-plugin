# Lore — Codex plugin

Share your Codex sessions to [Lore](https://lore.tanagram.ai) and read threads back, without leaving Codex.

## What you get

- `share-codex` — upload the current Codex rollout to Lore and return the shareable URL.
- `lore-read` — fetch a Lore thread by ID or URL, or search and list threads from Lore.

## Architecture

This plugin is intentionally a thin shim. It ships Codex-native skills only; the underlying session-sharing and thread-reading logic lives in [`@tanagram/lore`](https://www.npmjs.com/package/@tanagram/lore). On first use, the skills bootstrap the CLI with `npm install -g @tanagram/lore` if it is not already available.

## Files

- `.codex-plugin/plugin.json` — Codex plugin manifest
- `skills/share-codex/SKILL.md` — share the current Codex session
- `skills/lore-read/SKILL.md` — read and search Lore threads

## Requirements

Node.js 18+.
