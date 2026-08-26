/**
 * Claude Code PreToolUse hook for `share_session`.
 *
 * Plugin MCP servers are long-lived and can inherit a session id from the
 * process that launched them. That id does not identify the Claude
 * conversation making a later tool call. PreToolUse hooks, in contrast,
 * receive the current conversation id on every call. This hook copies that
 * id into an otherwise implicit share request before the MCP server sees it.
 *
 * Explicit `session_id` values are preserved so callers can still share an
 * older session. The transcript filename check confines implicit injection
 * to ordinary Claude Code project transcripts; Cowork and other hosts retain
 * their own session resolution contracts.
 */
import path from 'node:path';
import { z } from 'zod/v4';

const jsonValueSchema = z.json();

const preToolUseInputSchema = z.object({
  hook_event_name: z.literal('PreToolUse'),
  session_id: z.string().min(1),
  transcript_path: z.string().min(1),
  tool_input: z.record(z.string(), jsonValueSchema),
});

export type InjectShareSessionIdHookOutput = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    updatedInput: Record<string, z.infer<typeof jsonValueSchema>>;
  };
};

/** Return updated tool input only for an implicit Claude Code share. */
export function injectShareSessionId(
  input: z.input<typeof preToolUseInputSchema>,
): InjectShareSessionIdHookOutput | null {
  const parsed = preToolUseInputSchema.parse(input);
  const explicitSessionId = parsed.tool_input.session_id;
  if (typeof explicitSessionId === 'string' && explicitSessionId.trim() !== '') {
    return null;
  }

  if (path.basename(parsed.transcript_path) !== `${parsed.session_id}.jsonl`) {
    return null;
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: {
        ...parsed.tool_input,
        session_id: parsed.session_id,
      },
    },
  };
}

/** Read one hook event from stdin and write Claude's hook response to stdout. */
export async function runInjectShareSessionIdHook(): Promise<void> {
  const input = await new Response(Bun.stdin.stream()).json();
  const output = injectShareSessionId(input);
  process.stdout.write(JSON.stringify(output ?? {}));
}
