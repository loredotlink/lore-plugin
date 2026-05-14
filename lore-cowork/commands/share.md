---
description: Share the current Cowork session to Lore. Returns a shareable URL.
---

Share the user's current Cowork session to Lore.

Steps:

1. Call the `lore-cowork-local` MCP tool `read_local_session` with no arguments. The server resolves the current session from `COWORK_SESSION_ID` or the most-recently-modified session on disk. It returns `{ session_id, conversation_id, transcript, uploads, outputs }`.

2. If the user asked to share a *specific* older session ("share the one from yesterday", "share session abc-123"), call `list_local_sessions` on `lore-cowork-local` first, pick the matching entry, then call `read_local_session({ session_id })`.

3. Call the `lore` MCP tool `share_session({ transcript, harness: 'cowork' })`. The `harness` argument is required (per lore PR #484) and must be the literal string `'cowork'` for this plugin — omitting it returns InvalidParams. Do NOT pass `workspace_id`; the cloud forces private visibility, which is the v1 default. The call returns `{ thread_id, thread_url }`.

4. Respond in plain language. Surface `thread_url` to the user as a clickable link. If `uploads` or `outputs` were non-empty, mention them briefly (e.g. "shared along with 2 attached files"). Speak about "this session" and "shared link" — never say "transcript", "JSONL", or "MCP".

Failure modes:

- `read_local_session` errors with "no Cowork session found" → ask the user if they want to share an older one, then list with `list_local_sessions`.
- `share_session` errors → surface the message verbatim and suggest a retry.
- Auth errors → Cowork will re-prompt for consent on its own; let that flow happen. If this is the user's first share, briefly note they may see a sign-in prompt from Lore; subsequent shares are silent.
- Empty session content → tell the user the session has nothing to share yet.
