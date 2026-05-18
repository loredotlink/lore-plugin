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
