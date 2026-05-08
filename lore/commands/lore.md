---
description: Read from Lore — fetch a thread by ID/URL or list/search threads. Bootstraps the @tanagram/lore CLI on first use.
---

Bootstrap the CLI if it's missing, then run the appropriate `lore` command based on `$ARGUMENTS`:

- If `$ARGUMENTS` looks like a thread ID (`th_...`) or a Lore URL (`https://lore.tanagram.ai/session/th_...`), run `tanagram lore get $ARGUMENTS`.
- Otherwise, treat `$ARGUMENTS` as a natural-language query and translate it into `tanagram lore list` flags (`--filepath-prefixes`, `--author-ids`, `--created-at <unix>...<unix>`, `--before`, `--after`).

```bash
command -v tanagram >/dev/null 2>&1 || npm install -g @tanagram/lore
```

Both subcommands emit JSON. Parse it and summarize for the user (thread ID, title, author, URL, matching filepaths). For single-thread fetches, surface the URL prominently. For lists, show the top matches with one-line summaries; mention pagination cursors only if useful.

Failure modes: "not logged in" → tell the user to run `tanagram login`. Missing `npm` → tell them to install Node.js 18+ from https://nodejs.org. Empty list results → say no threads matched and suggest loosening filters.
