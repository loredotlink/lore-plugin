import { describe, expect, test } from 'bun:test';
import { injectShareSessionId } from './injectShareSessionId';

describe('injectShareSessionId', () => {
  test('injects the current Claude Code session into an implicit share', () => {
    expect(
      injectShareSessionId({
        hook_event_name: 'PreToolUse',
        session_id: 'current-session',
        transcript_path: '/Users/q/.claude/projects/-repo/current-session.jsonl',
        tool_input: { visibility: 'workspace' },
      }),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          visibility: 'workspace',
          session_id: 'current-session',
        },
      },
    });
  });

  test('preserves an explicit older session selection', () => {
    expect(
      injectShareSessionId({
        hook_event_name: 'PreToolUse',
        session_id: 'current-session',
        transcript_path: '/Users/q/.claude/projects/-repo/current-session.jsonl',
        tool_input: { session_id: 'older-session' },
      }),
    ).toBeNull();
  });

  test('does not inject a Claude id into another runtime transcript', () => {
    expect(
      injectShareSessionId({
        hook_event_name: 'PreToolUse',
        session_id: 'claude-wrapper-session',
        transcript_path: '/Users/q/local-agent-mode-sessions/local_123/audit.jsonl',
        tool_input: {},
      }),
    ).toBeNull();
  });
});
