---
name: fork
description: Distill a Lore thread into handoff context for continuing work. Use when the user asks to continue work from a Lore thread, fork from a thread, pick up from a thread, or use a Lore thread as context for a new task.
argument-hint: "<lore-thread-url-or-id> <forker-intent>"
---

# Fork a Lore Thread

Use the bundled `lore-local` MCP server to generate an intent-conditioned handoff summary for a Lore thread.

## When to Use

Use this skill when the user asks to:

- continue work from a Lore thread
- fork from a Lore thread
- pick up from a previous Lore thread
- use a Lore thread as context for a specific next task

Do not use this for merely reading or listing Lore threads. Use the `read` skill for read-only thread inspection.

## Inputs

This skill needs two inputs:

1. A Lore thread URL or ID. Accepted examples include `th_...` and `https://lore.tanagram.ai/thread/th_...`.
2. Forker intent: what the user wants to do next with the source thread.

If either input is missing, ask one concise clarification question before calling the tool.

## Tool Flow

1. Extract the thread id from the URL path if needed.
2. Call `fork_thread({ thread_id, forker_intent })` on `lore-local`.
3. Treat the returned `source_distilled` text as the source-thread context for the current task.

The fork result is a JSON object with:

- `source_thread_id` — the source Lore thread id.
- `forker_intent` — the intent used for the distillation.
- `source_distilled` — the handoff context for the new agent.

Do not show raw JSON to the user unless they explicitly ask for it. If the user only asked to prepare the fork context, return `source_distilled` verbatim. If they asked to continue the work, briefly acknowledge that the fork context was loaded and proceed with the task using that context.

## Failure Modes

- Auth errors:
  Call `lore_login` on `lore-local`, then retry. If `lore_login` returns `browser_open_failed`, tell the user to visit the verification URL, then call `lore_login_resume({ device_code })` and retry.
- Thread not found or not visible:
  Tell the user the thread could not be found or they do not have access, and ask for a visible Lore thread URL or ID.
- Missing `source_distilled`:
  Surface the error and do not invent fork context.

## Tone

Speak about "threads" and "handoff context". Never say "transcript", "JSONL", or "MCP" to the user.
