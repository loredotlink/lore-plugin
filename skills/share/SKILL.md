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

## Naming the Thread

If the user asks to name the thread while sharing — for example "share and name it My Thread", "share as Auth refactor", "share this and call it X" — extract the requested name and pass it as the `title` argument to the share tool. The title sets the thread's name instead of letting Lore auto-generate one from the transcript.

- "share and name it Onboarding redesign" → call the share tool with `title: "Onboarding redesign"`.
- "share this session" (no name given) → omit `title`; Lore generates one.

Strip framing words ("name it", "call it", "titled", surrounding quotes) and pass only the title itself.

## Tool Flow

1. Call the `lore-local` MCP tool `share_session` with no arguments.
2. If the user includes a natural-language highlight request after `/share`, pass that request as `highlight`. For example, `/share where I made the parser handle Amp exports` should call `share_session({ highlight: "where I made the parser handle Amp exports" })`.
3. If the user asked for a specific older session, call `list_local_sessions`, pick the match, then call `share_session({ session_id })` (or `share_session({ session_id, highlight })` when they also asked for a highlight).
4. Surface `thread_url` prominently. If `clipboard_copied` is true, mention that the shared link was copied to the clipboard. If `clipboard_copied` is false, still show the link and mention that clipboard copy was unavailable. If `highlight` was supplied and resolved, `thread_url` already includes the selected block anchor or range. If the result includes `_tip`, show it after the link.

The share result is a JSON object with:

- `thread_id` — the Lore thread id.
- `thread_url` — the shareable Lore link. Always show this to the user as the primary result.
- `clipboard_copied` — true when the plugin copied `thread_url` to the user's clipboard, false when clipboard copy was unavailable.
- `highlight` — present only when a highlight query was supplied and Lore resolved it. It includes `query`, `matched`, `start_block_id`, and `end_block_id`; when `matched` is true, `thread_url` is already anchored.
- `_tip` — optional plugin tip text.

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
