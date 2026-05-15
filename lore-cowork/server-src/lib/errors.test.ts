import { describe, test, expect } from 'bun:test';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  AuthRequiredError,
  AUTH_REQUIRED_MESSAGE,
  authRequiredToMcpError,
} from './errors';
import { toCallToolResult } from '../index.js';

describe('AuthRequiredError', () => {
  test('is throwable and catchable via instanceof', () => {
    let caught: unknown;
    try {
      throw new AuthRequiredError();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuthRequiredError);
    expect(caught).toBeInstanceOf(Error);
  });

  test('preserves a default message when none is given', () => {
    const err = new AuthRequiredError();
    expect(typeof err.message).toBe('string');
    expect(err.message.length).toBeGreaterThan(0);
  });

  test('preserves a custom message when provided', () => {
    const err = new AuthRequiredError('custom reason');
    expect(err.message).toBe('custom reason');
  });

  test('retains a .stack trace', () => {
    const err = new AuthRequiredError();
    expect(typeof err.stack).toBe('string');
    expect((err.stack as string).length).toBeGreaterThan(0);
  });

  test('has the class name "AuthRequiredError"', () => {
    // Useful for log lines that print `error.name`.
    const err = new AuthRequiredError();
    expect(err.name).toBe('AuthRequiredError');
  });
});

describe('AUTH_REQUIRED_MESSAGE', () => {
  test('contains the literal substring "lore_login"', () => {
    expect(AUTH_REQUIRED_MESSAGE).toContain('lore_login');
  });

  test('is a non-empty string', () => {
    expect(typeof AUTH_REQUIRED_MESSAGE).toBe('string');
    expect(AUTH_REQUIRED_MESSAGE.length).toBeGreaterThan(0);
  });
});

describe('authRequiredToMcpError', () => {
  test('returns isError: true with exactly one text content block', () => {
    const result = authRequiredToMcpError();
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toBe(AUTH_REQUIRED_MESSAGE);
  });

  test('round-trips unchanged through index.ts:toCallToolResult', () => {
    // The dispatcher in index.ts passes any object with a `content` (or
    // `structuredContent`) field through to the wire unchanged. The
    // auth-required error is built to take that fast path so the
    // `isError: true` flag and message reach the agent verbatim.
    const error = authRequiredToMcpError();
    const wrapped: CallToolResult = toCallToolResult(error);
    expect(wrapped).toBe(error);
  });
});
