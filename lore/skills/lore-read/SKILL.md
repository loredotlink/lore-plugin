---
name: lore-read
description: >-
  Read information from Lore (the team's shared thread library). Use when the
  user asks to fetch a specific Lore thread, search/list threads, or find
  threads by filepath, author, or time range. Examples: "show me that Lore
  thread", "what did my coworker share on Lore last week", "find Lore
  threads that touched src/foo.ts", "list recent Lore sessions". Shells out
  to the `tanagram lore get` and `tanagram lore list` CLI commands.
allowed-tools: Bash
---

# Read from Lore

Fetches data from Lore via the `tanagram` CLI. Two underlying commands:

- `tanagram lore get <thread-id-or-url>` — fetch a single thread by ID or session URL.
- `tanagram lore list [flags]` — list/search threads with optional filters.

Both print a JSON payload on stdout. Parse the JSON and summarize for the user; only show raw JSON if they ask for it.

## When to Use

Run when the user asks to:

- "show me / open / read Lore thread <id-or-url>"
- "what did <coworker> post / share on Lore"
- "find Lore threads about <filepath / directory>"
- "list recent Lore threads" or "Lore threads from <time range>"
- "search Lore for ..."

Do NOT run proactively. Only on explicit request.

## Bootstrap

Before running any `tanagram lore` command, ensure the CLI is installed:

```bash
command -v tanagram >/dev/null 2>&1 || npm install -g @tanagram/lore
```

If `npm` is missing, tell the user to install Node.js 18+ from https://nodejs.org.

## Fetching a Single Thread

When the user gives a thread ID (`th_...`) or a Lore session URL (`https://lore.tanagram.ai/session/th_...`):

```bash
command -v tanagram >/dev/null 2>&1 || npm install -g @tanagram/lore
tanagram lore get <thread-id-or-url>
```

The argument can be either form — the CLI extracts the thread ID from a URL automatically.

## Listing / Searching Threads

```bash
command -v tanagram >/dev/null 2>&1 || npm install -g @tanagram/lore
tanagram lore list [--before <cursor>] [--after <cursor>] \
                   [--author-ids <id1,id2,...>] \
                   [--created-at <unix> | <start>...<end>] \
                   [--filepath-prefixes <prefix1,prefix2,...>]
```

Flag reference:

- `--filepath-prefixes` — comma-separated filepath prefixes. Matches threads whose sessions touched files under any of those prefixes. Use this for "threads about <some path>".
- `--author-ids` — comma-separated **Lore user IDs** (not names or emails). If the user names a coworker, you need their Lore user ID; if you don't have it, ask the user or fetch a recent unfiltered list and look for their ID in the results before filtering.
- `--created-at` — either a single Unix timestamp (seconds) or a `<start>...<end>` range of Unix timestamps. Convert any human time range ("last week", "since Monday") into Unix seconds before passing.
- `--before` / `--after` — pagination cursors returned in a previous list response. Use these to page through large result sets, not for time filtering (that's `--created-at`).

Combine flags freely — they AND together server-side.

## Output

Both commands emit a single JSON object/array on stdout. After running:

1. Parse the JSON.
2. Summarize the relevant fields for the user (thread ID, title/topic, author, created time, URL, matching filepaths, etc.) instead of dumping raw JSON.
3. If the user asked for a single thread, surface its Lore URL prominently so they can click through.
4. If listing, show the top results with their URLs and a one-line hint each. Mention pagination cursors only if the user is likely to want more.

## Failure Modes

- **Not logged in**: command returns `not logged in - run 'tanagram login' first`. Tell the user to run `tanagram login`.
- **Bad thread ref**: `tanagram lore get` requires either a `th_...` ID or a Lore session URL. If the user passes something else, ask them to clarify or provide the URL.
- **Unknown author**: `--author-ids` only accepts Lore user IDs. If the user gives a name/email and you don't have a mapping, run `tanagram lore list` without the author filter (optionally narrowed by `--created-at` or `--filepath-prefixes`) and find the ID from the results, or ask the user.
- **Empty results**: not an error — tell the user no threads matched and suggest loosening filters.
- **`npm` missing**: ask the user to install Node.js 18+ from https://nodejs.org.

## What This Does NOT Do

- It does not export the current session — that's the `share` skill (`tanagram lore export`).
- It does not modify threads, comments, visibility, or any Lore state. It is read-only.
- It does not start or manage the Lore background daemon.
