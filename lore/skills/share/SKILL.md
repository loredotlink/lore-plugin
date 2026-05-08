---
name: share
description: Share (export) the current Claude Code session to Lore and get back a shareable URL. Use when the user says "share this thread", "send this to Lore", "export this conversation", "post this to Lore", or asks for a link to the current session. Safe to invoke explicitly on request — do not run proactively.
allowed-tools: Bash
---

# Share to Lore

Exports the Claude Code session you are currently running in to Lore (the team's shared thread library) and prints the URL. Lore dedupes session exports by session ID, so re-sharing the same session is safe — it returns the existing thread.

## When to Use

Run when the user asks to:

- "share this thread / conversation / session"
- "send this to Lore"
- "export this to Lore"
- "get a Lore link for this"
- "post this to Lore"

Do NOT run this proactively. Only on explicit request.

## Bootstrap

Before running the export, ensure the `tanagram` CLI is installed. The plugin does not bundle it; install on first use:

```bash
command -v tanagram >/dev/null 2>&1 || npm install -g @tanagram/lore
```

If `npm` itself is missing, tell the user to install Node.js 18+ from https://nodejs.org and try again. Do not attempt to install Node.

## Command

**Always** pass `--session-id ${CLAUDE_SESSION_ID}` so the CLI exports *this* session — the one the user just asked to share. Claude Code substitutes `${CLAUDE_SESSION_ID}` with the current session's ID; the CLI will not guess it for you.

Use this command as the default implementation:

```bash
command -v tanagram >/dev/null 2>&1 || npm install -g @tanagram/lore
tanagram lore export --session-id ${CLAUDE_SESSION_ID} --visibility workspace
```

Do **not** omit `--session-id` and rely on the cwd-match fallback. The fallback picks the most recent history entry for the current directory, which is frequently a *different* session (a prior run, a parallel worktree, etc.) — the user then has to retry with the explicit flag. The skill runtime gives you the session ID for free, so always pass it.

If the user wants to share a *different* session, substitute their ID for `${CLAUDE_SESSION_ID}` in the export command above.

If the user explicitly asks to share publicly (anyone with the link) or to keep the thread private to themselves, change the `--visibility` flag to `public` or `private` respectively. Default to `workspace` whenever the user just says "share".

## Output

The export command prints a single JSON object on stdout:

```json
{
  "thread_id": "th_...",
  "url": "https://lore.tanagram.ai/session/th_...",
  "session_id": "...",
  "project": "/Users/me/repo",
  "reused": false,
  "visibility": "workspace",
  "clipboard_copied": true
}
```

- `url` — the shareable Lore link for the session thread. **Always show this to the user as the primary result.**
- `clipboard_copied` — `true` when the URL was copied to the system clipboard. Mention this to the user when `true` so they know they can paste it directly.

## After Running

Echo the session URL back to the user as a clickable link. If `clipboard_copied` is `true`, add a short note that the URL is on their clipboard. Do not list other threads, summarize the conversation, or take any additional action unless the user asks. A minimal response looks like:

> Shared: https://lore.tanagram.ai/session/th_abc123 (copied to clipboard).

## Failure Modes

- **Not logged in**: the command returns `not logged in — run 'tanagram login' first`. Tell the user to run `tanagram login` and try again.
- **No matching history entry**: this happens when `${CLAUDE_SESSION_ID}` isn't present in `~/.claude/history.jsonl` yet (very fresh session) or when the user asked to share a session that the CLI can't find. Ask the user which session they want to share, or suggest `--session-id <id>` / `--project <path>` with the value they provide.
- **Lore offline**: the command suggests setting `TANAGRAM_LORE_URL` when the SaaS endpoint is unreachable. Relay the message verbatim.
- **`npm` missing**: ask the user to install Node.js 18+ from https://nodejs.org.

## What This Does NOT Do

- It does not start the Lore background daemon. For ongoing auto-sync of every session, `tanagram lore enable` is the right command.
- It does not change the thread title, comments, or other metadata. The user can adjust those in the Lore UI after sharing.
