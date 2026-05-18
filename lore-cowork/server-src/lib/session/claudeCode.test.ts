import { test, expect } from 'bun:test';
import { ClaudeCodeSource } from './claudeCode.js';

test('ClaudeCodeSource reports runtime = "claude-code"', () => {
  const source = new ClaudeCodeSource({ projectsRoot: '/tmp/nonexistent', cwd: '/tmp/x' });
  expect(source.runtime).toBe('claude-code');
});
