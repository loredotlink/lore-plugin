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

## Slack Integration

If the user says "share to #channel", "post to #eng", or includes a Slack channel name (with or without the `#` prefix), do the following **after** the Lore export succeeds:

1. Extract the `thread_id` from the export output.
2. Strip the leading `#` from the channel name if present.
3. Read the auth token from `~/.lore/token` (prod) or `~/.lore-dev/token` (dev). If neither exists, tell the user to run `lore login` first.
4. Determine the API base URL: use `LORE_API_URL` env var if set, otherwise `https://lore-api.tanagram.ai` for prod or `http://localhost:4000` for dev (check which token file exists).
5. Post to Slack via the API directly:

```bash
if [ -n "$LORE_API_URL" ]; then
  API_BASE="$LORE_API_URL"
elif [ -f ~/.lore-dev/token ]; then
  API_BASE="http://localhost:4000"
else
  API_BASE="https://lore-api.tanagram.ai"
fi
TOKEN=$(cat ~/.lore/token 2>/dev/null || cat ~/.lore-dev/token 2>/dev/null)
curl -s -X POST "$API_BASE/api/slack/post" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"channel_name\": \"CHANNEL\", \"thread_id\": \"THREAD_ID\"}"
```

Replace `CHANNEL` with the channel name (no `#` prefix) and `THREAD_ID` with the `thread_id` from the export output.

If `lore slack post` is available (check with `lore slack --help 2>/dev/null`), you may use that instead:

```bash
lore slack post CHANNEL --thread-id THREAD_ID
```

6. If the response contains `"ok":true`, confirm to the user that the thread was posted to the channel.
7. If it fails with "No Slack installation", tell the user to connect Slack from Account Settings first.
8. If it fails with a channel error, tell the user the bot may not be in that channel and suggest `/invite @Lore` in Slack.

When Slack posting is requested, the response should look like:

> Shared: https://lore.tanagram.ai/session/th_abc123 (copied to clipboard).
> Posted to #eng in Slack.

If the user just says "share" without mentioning a channel, skip the Slack step entirely.


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
