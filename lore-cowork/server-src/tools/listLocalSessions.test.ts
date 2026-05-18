import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listLocalSessionsTool,
  runListLocalSessions,
  type ListLocalSessionsResult,
} from './listLocalSessions';
import { CoworkSource } from '../lib/session/cowork.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-cowork-list-test-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Create a session directory at `<root>/<conv>/<sess>/local_<id>/` with
 * a minimal audit.jsonl so it's a recognisable session. mtime is set
 * on the session directory (not its parent or children) — that's what
 * `listSessions` orders by.
 */
function makeSession(
  root: string,
  conversationId: string,
  sessionId: string,
  mtimeMs: number,
): void {
  const sessionDir = path.join(root, conversationId, sessionId);
  const localDir = path.join(sessionDir, 'local_abc');
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(path.join(localDir, 'audit.jsonl'), '{}\n', 'utf8');
  const t = mtimeMs / 1000;
  fs.utimesSync(sessionDir, t, t);
}

describe('listLocalSessionsTool — shape', () => {
  test('exports a tool named "list_local_sessions"', () => {
    expect(listLocalSessionsTool.name).toBe('list_local_sessions');
  });

  test('has a non-empty description that mentions browsing older sessions', () => {
    expect(typeof listLocalSessionsTool.description).toBe('string');
    expect(listLocalSessionsTool.description.length).toBeGreaterThan(0);
    // The description must orient the agent: this is for explicit
    // selection, not the default share flow.
    expect(listLocalSessionsTool.description.toLowerCase()).toContain('default share flow');
  });

  test('has an empty-object input schema with additionalProperties: false', () => {
    expect(listLocalSessionsTool.inputSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  test('handler is an async function', () => {
    expect(typeof listLocalSessionsTool.handler).toBe('function');
  });
});

describe('runListLocalSessions — behavior', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  test('returns { sessions: [] } when the root does not exist', () => {
    const missing = path.join(tmp, 'does-not-exist');
    const source = new CoworkSource({ sessionsRoot: missing });
    const result = runListLocalSessions(source);
    expect(result).toEqual({ sessions: [] });
  });

  test('returns { sessions: [] } when the root exists but is empty', () => {
    const root = path.join(tmp, 'empty-root');
    fs.mkdirSync(root);
    const source = new CoworkSource({ sessionsRoot: root });
    expect(runListLocalSessions(source)).toEqual({ sessions: [] });
  });

  test('returns sessions newest-first, mapped to snake_case keys', () => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    makeSession(root, 'convA', 'sess-old', 1_000_000);
    makeSession(root, 'convB', 'sess-mid', 2_000_000);
    makeSession(root, 'convA', 'sess-new', 3_000_000);

    const source = new CoworkSource({ sessionsRoot: root });
    const result = runListLocalSessions(source);
    expect(result.sessions).toHaveLength(3);
    expect(result.sessions[0]).toEqual({
      session_id: 'sess-new',
      conversation_id: 'convA',
      mtime_ms: 3_000_000,
    });
    expect(result.sessions[1]).toEqual({
      session_id: 'sess-mid',
      conversation_id: 'convB',
      mtime_ms: 2_000_000,
    });
    expect(result.sessions[2]).toEqual({
      session_id: 'sess-old',
      conversation_id: 'convA',
      mtime_ms: 1_000_000,
    });
  });

  test('result is JSON-serializable (no Date instances, no cycles)', () => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    makeSession(root, 'conv', 'sess', 1_000_000);

    const source = new CoworkSource({ sessionsRoot: root });
    const result = runListLocalSessions(source);
    const roundTripped = JSON.parse(JSON.stringify(result)) as ListLocalSessionsResult;
    expect(roundTripped).toEqual(result);
    // mtime_ms must be a number, not a serialized Date.
    expect(typeof roundTripped.sessions[0].mtime_ms).toBe('number');
  });

  test('only exposes the documented snake_case keys (no camelCase leakage)', () => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    makeSession(root, 'conv', 'sess', 1_000_000);

    const source = new CoworkSource({ sessionsRoot: root });
    const result = runListLocalSessions(source);
    expect(Object.keys(result.sessions[0]).sort()).toEqual([
      'conversation_id',
      'mtime_ms',
      'session_id',
    ]);
  });
});

describe('listLocalSessionsTool.handler — integration', () => {
  test('does not throw when the real default sessions root is missing', async () => {
    // We can't redirect `defaultSessionsRoot()` from the handler (the
    // contract forbids env/arg seams), but we CAN assert the handler
    // never throws regardless of what's on disk. If the user's machine
    // has sessions, we get a populated result; if not, we get []. Both
    // are valid; what matters is that the call resolves cleanly.
    const result = (await listLocalSessionsTool.handler({})) as ListLocalSessionsResult;
    expect(result).toHaveProperty('sessions');
    expect(Array.isArray(result.sessions)).toBe(true);
    // Every entry — if any — must match the documented snake_case shape.
    for (const entry of result.sessions) {
      expect(typeof entry.session_id).toBe('string');
      expect(typeof entry.conversation_id).toBe('string');
      expect(typeof entry.mtime_ms).toBe('number');
    }
  });
});
