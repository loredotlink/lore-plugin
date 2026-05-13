---
description: Read from Lore — fetch a thread by ID/URL or list/search threads.
---

Pick the right tool on the `lore` MCP server based on `$ARGUMENTS`:

- Thread ID (`th_...`) or a Lore URL (e.g. `https://lore.tanagram.ai/session/th_...`) → `get_thread({ thread_id })`. Extract the id from the URL path if needed.
- Keyword phrase → `search_threads({ query: $ARGUMENTS, limit: 10 })`.
- "recent", "latest", or empty `$ARGUMENTS` → `list_threads({ limit: 10 })`.

Render results in plain language:

- Single-thread fetches: surface the URL prominently along with the title and author.
- Lists: show the top matches as one-liners (title, author, link). Mention pagination cursors only if it's useful.
- Empty results: say nothing matched and suggest loosening the query.

Tone rules: speak about "threads" and "shared sessions" — never say "transcript", "JSONL", or "MCP" to the user. Auth errors → Cowork handles re-consent on its own; surface the message and let the prompt flow happen. If this is the user's first read, they may see a sign-in prompt from Lore; subsequent reads are silent.
