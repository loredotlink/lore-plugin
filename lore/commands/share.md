---
description: Share the current session to Lore. Returns a shareable URL. Works in both Claude Code and Cowork.
---

Share the user's current session to Lore. The plugin auto-detects whether it is running inside Claude Code or Cowork and resolves the right session on disk — the skill works identically in both environments.

Steps:

1. Call the `lore-local` MCP tool `share_session` with no arguments. The plugin resolves the current session automatically (via `CLAUDE_SESSION_ID` in Claude Code, `COWORK_SESSION_ID` in Cowork, or the most-recently-modified session on disk as a fallback), reads its transcript itself, and forwards it to Lore. The call returns `{ thread_id, thread_url, _tip? }`. **Do not** call `read_local_session` first — the transcript bytes should never enter your context; the plugin handles the read internally.

2. If the user asked to share a *specific* older session ("share the one from yesterday", "share session abc-123"), call `list_local_sessions` on `lore-local` first, pick the matching entry, then call `share_session({ session_id })`. Again, do not call `read_local_session`.

3. Respond in plain language. Surface `thread_url` to the user as a clickable link. If the result also contains a `_tip` field, display its text to the user after the thread link. Speak about "this session" and "shared link" — never say "transcript", "JSONL", or "MCP".

Failure modes:

- `share_session` errors with "no session found" → ask the user if they want to share an older one, then list with `list_local_sessions`.
- `share_session` errors with "session not found: <id>" → tell the user the id didn't match and offer to list with `list_local_sessions`.
- Other `share_session` errors → surface the message verbatim and suggest a retry.
- Auth errors → call the `lore-local` MCP tool `lore_login` and retry the share once it succeeds. If `lore_login` returns `browser_open_failed`, tell the user to visit the provided verification URL, then call `lore_login_resume({ device_code })` with the returned device code and retry the share once it succeeds.
- Empty session content → tell the user the session has nothing to share yet.

If you want to mention attached files in your response, you may call `read_local_session` *after* a successful share to inspect `uploads` and `outputs` — but do not call it before, and never pass its `transcript` field anywhere.
