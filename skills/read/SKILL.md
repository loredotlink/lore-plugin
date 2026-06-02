---
name: read
description: Read from Lore by fetching a thread by ID or URL, or by listing and searching threads. Use when the user asks to open a Lore thread, find recent Lore sessions, or search Lore for a topic, author, or filepath.
---

# Read from Lore

Use the bundled `lore-local` MCP server to fetch or search Lore threads.

You can search threads semantically with a natural-language query. Use `search_threads` when the user asks an open-ended question about prior discussions, decisions, or work, not just when they provide exact keywords.

## Tool Selection

- Thread ID like `th_...` or a Lore URL:
  Call `get_thread({ thread_id })`. Extract the id from the URL path if needed.
- Keyword phrase:
  Call `search_threads({ query, limit: 10 })`.
- Semantic/open-ended question:
  Call `search_threads({ query: question, limit: 10 })`. Use this when the user asks about threads in a broad way that cannot be captured by deterministic filters. Examples:
  - "what have we been thinking about our open-source strategy?"
  - "what did we say about running multiple fastify replicas in railway?"
  - "what are some recent decisions we've made about our Posthog setup?"
- "recent", "latest", or no specific query:
  Call `list_threads({ limit: 10 })`.

## Output

- Single-thread fetches:
  Surface the URL prominently along with the title and author.
- Lists:
  Show the top matches as one-liners with title, author, and link.
- Empty results:
  Say nothing matched and suggest loosening the query.

## Failure Modes

- Auth errors:
  Call `lore_login` on `lore-local`, then retry. If `lore_login` returns `browser_open_failed`, tell the user to visit the verification URL, then call `lore_login_resume({ device_code })` and retry.

## Tone

Speak about "threads" and "shared sessions". Never say "transcript", "JSONL", or "MCP" to the user.
