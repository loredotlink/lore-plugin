import { test, expect } from 'bun:test';
import { detectSource } from './index.js';

test('detectSource: returns CoworkSource when no Claude Code env is set', () => {
  const source = detectSource({});
  expect(source.runtime).toBe('cowork');
});

test('detectSource: ignores blank CLAUDE_SESSION_ID and falls back to Cowork', () => {
  expect(detectSource({ CLAUDE_SESSION_ID: '' }).runtime).toBe('cowork');
  expect(detectSource({ CLAUDE_SESSION_ID: '   ' }).runtime).toBe('cowork');
});

test('detectSource: returns ClaudeCodeSource when CLAUDE_SESSION_ID is set', () => {
  expect(detectSource({ CLAUDE_SESSION_ID: 'sess-abc' }).runtime).toBe('claude-code');
});

test('detectSource: ClaudeCodeSource branch wins over COWORK_SESSION_ID', () => {
  expect(
    detectSource({ CLAUDE_SESSION_ID: 'sess-abc', COWORK_SESSION_ID: 'sess-xyz' }).runtime,
  ).toBe('claude-code');
});
