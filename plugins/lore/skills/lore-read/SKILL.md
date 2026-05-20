---
name: lore-read
description: Read information from Lore by fetching a thread by ID or URL, or by searching and listing threads. Use when the user asks to open a Lore thread, find Lore sessions, or search Lore for a topic, author, or filepath.
---

# Read from Lore

Bootstrap the Lore CLI if it is missing, then use the Lore thread commands to fetch or search threads.

## When to Use

Use this skill when the user asks to:

- open or read a Lore thread
- show a Lore thread from a URL
- find Lore threads about a file or folder
- list recent Lore sessions
- search Lore for a topic, author, or time range

Do not use it to share the current session. That is `share-codex`.

## Command Selection

First bootstrap the CLI if needed:

```bash
command -v lore >/dev/null 2>&1 || npm install -g @tanagram/lore
```

Then choose the right Lore command:

- If the user gives a thread ID like `th_...` or a Lore URL like `https://lore.tanagram.ai/session/th_...`, run:

```bash
lore threads get <thread-id-or-url>
```

- Otherwise, translate the user's request into `lore threads list` filters such as:

```bash
lore threads list [--before <cursor>] [--after <cursor>] \
                  [--author_ids <id1,id2,...>] \
                  [--created_at <unix> | <start>...<end>] \
                  [--filepath_prefixes <prefix1,prefix2,...>]
```

## Output

Both commands emit JSON. Parse it and summarize the important details for the user instead of dumping the raw payload:

- single thread: title, author, URL, and the key reason it matches
- lists: the top matches with one-line summaries and URLs

If nothing matches, say so and suggest loosening the filters.

## Failure Modes

- `not logged in` — tell the user to run `lore login`.
- missing `npm` — tell the user they need Node.js 18+.
- empty results — report that nothing matched.

## Tone

Speak in terms of Lore threads and shared sessions. Keep the result concise and lead with the Lore URL when there is a single matching thread.
