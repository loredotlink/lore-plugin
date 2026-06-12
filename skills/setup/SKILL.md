---
name: setup
description: Set up Lore, enable or disable background session capture, or check the current capture status. Use when the user asks to set up Lore, turn on auto-capture, enable background capture, disable capture, or check whether Lore is capturing sessions.
---

# Set up Lore background capture

Use the bundled `lore-local` MCP server to check the current capture state and surface the appropriate action — either the consent text (if capture hasn't been configured yet) or the current status (if it has).

## When to Use

Use this skill when the user asks to:

- set up Lore
- enable auto-capture or background capture
- turn on background session capture
- disable or turn off capture
- check whether Lore is capturing sessions
- see the Lore capture status

## Tool Flow

1. Call the `lore-local` MCP tool `lore_setup` with no arguments.
2. Surface the result directly to the user.
   - If the result includes consent text, read it and offer to call `lore_consent` on the user's behalf.
   - If the result includes a status description, read it and present it clearly.

Do not reinterpret or soften the consent text — surface it as returned. The text is self-contained.

## Interpreting the Result

- **Consent text** (user hasn't enabled capture yet, or previously skipped):
  Read the returned text aloud and offer to call `lore_consent` with `approve: true` to enable capture or `approve: false` to skip. On unsupported platforms, only offer the skip path.

- **Status result** (capture already configured):
  Read the status text and summarise it in one sentence. Always include the next action the user can take (e.g. "To disable, call `lore_consent` with `approve: false`").

## Failure Modes

- `lore_setup` errors unexpectedly:
  Tell the user that setup could not load the current state and suggest they try again. If the error mentions a corrupt file, point them to `~/Library/Application Support/tanagram/lore/plugin-state.json`.

## Tone

Speak about "background capture", "auto-capture", or "session capture". Never say "JSONL", "MCP", or "transcript" to the user.
