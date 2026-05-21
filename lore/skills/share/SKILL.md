---
name: share
description: Share the current session to Lore and return a shareable URL. Use when the user asks to share this session, send it to Lore, export this conversation, or get a Lore link for the current session.
---

# Share session to Lore

Use the bundled `lore-local` MCP server. It resolves the active session on disk itself, uploads it to Lore with the correct harness for the current runtime, and returns a shareable thread URL.

## When to Use

Use this skill when the user asks to:

- share this session
- send this conversation to Lore
- export this session to Lore
- get a Lore link for the current session

Do not call `read_local_session` before sharing. The transcript bytes should not pass through the agent context.

## Tool Flow

1. Call the `lore-local` MCP tool `share_session` with no arguments.
2. If the user asked for a specific older session, call `list_local_sessions`, pick the match, then call `share_session({ session_id })`.
3. Surface `thread_url` prominently. If the result includes `_tip`, show it after the link.

## Failure Modes

- `share_session` errors with `no session found`:
  Ask whether they want to share an older session, then list with `list_local_sessions`.
- `share_session` errors with `session not found: <id>`:
  Tell the user the id did not match and offer to list available sessions.
- Auth errors:
  Call `lore_login` on `lore-local`, then retry the share. If `lore_login` returns `browser_open_failed`, tell the user to visit the verification URL, then call `lore_login_resume({ device_code })` and retry.
- Empty session content:
  Tell the user the session has nothing to share yet.

## Tone

Speak about "this session" and the "shared link". Never say "transcript", "JSONL", or "MCP" to the user.
