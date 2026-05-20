---
name: share-codex
description: Share the current Codex session to Lore and return a shareable URL. Use when the user asks to share this thread, send it to Lore, export the current Codex conversation, or get a Lore link for the current session.
---

# Share Codex session to Lore

Bootstrap the Lore CLI if it is missing, locate the current Codex rollout file, and upload it to Lore.

## When to Use

Use this skill when the user asks to:

- share this Codex thread or session
- send this conversation to Lore
- export this session to Lore
- get a Lore link for the current session

Do not run it proactively.

## Command

Run this bash snippet:

```bash
command -v lore >/dev/null 2>&1 || npm install -g @tanagram/lore
SESSION_FILE=$(find "$HOME/.codex/sessions" -name "*${CODEX_SESSION_ID}.jsonl" 2>/dev/null | head -1)
if [ -z "$SESSION_FILE" ]; then
  echo "Could not locate Codex session file for session id ${CODEX_SESSION_ID}" >&2
  exit 1
fi
lore share-codex --session-file "$SESSION_FILE" --visibility workspace
```

`CODEX_SESSION_ID` is set by Codex inside the running session. If it is empty, ask the user which session they want to share before proceeding.

If the user explicitly asks to share publicly, change `--visibility workspace` to `--visibility public`. If they explicitly ask to keep it private, use `--visibility private`. Default to `workspace` when they just say "share".

## Output

The command prints a JSON object with a `url` field. Surface that Lore URL prominently to the user as the main result.

If `clipboard_copied` is `true`, mention that the URL was copied to the clipboard.

## Failure Modes

- `lore is logged out` or `not logged in` — tell the user to run `lore login` and retry.
- `Could not locate Codex session file...` — ask the user to send another message in Codex and retry, or ask whether they want to share an older session.
- missing `npm` — tell the user they need Node.js 18+.
- other CLI or network errors — relay the message plainly.

## Tone

Tell the user the session was shared and give them the Lore link. Do not dump raw JSON unless they ask.
