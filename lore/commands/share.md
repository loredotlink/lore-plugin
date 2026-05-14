---
description: Share the current Claude Code session to Lore. Bootstraps the @tanagram/lore CLI on first use.
---

Run this bash command. Bootstrap the CLI if it's missing, then export this session.

```bash
command -v lore >/dev/null 2>&1 || npm install -g @tanagram/lore
lore export --session-id ${CLAUDE_SESSION_ID} --visibility workspace $ARGUMENTS
```

The export prints a JSON object with a `url` field — show that URL to the user as a clickable link. If `clipboard_copied` is true, mention the URL was copied to their clipboard. Default visibility is `workspace`; if the user said "publicly" or "privately", swap `--visibility workspace` for `--visibility public` or `--visibility private`.

If the command fails with "not logged in", tell the user to run `lore login`. If `npm` is missing, tell them to install Node.js 18+ from https://nodejs.org.
