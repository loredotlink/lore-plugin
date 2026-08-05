import { describe, expect, test } from 'bun:test';
import type { PluginAPI } from '@ampcode/plugin';

import { installPassiveAmpThreadMirror, type PassiveMirrorDeps } from './passiveMirror';

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

function harness(overrides: Partial<PassiveMirrorDeps> = {}) {
  const handlers = new Map<string, Handler[]>();
  const uploads: Array<{ threadId: string; token: string; body: unknown }> = [];
  let token = 0;
  const amp = {
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    logger: { log: () => undefined },
  } as unknown as PluginAPI;
  const deps: PassiveMirrorDeps = {
    exportThread: async (threadId) => ({ id: threadId, messages: [{ role: 'user', messageId: 'm1', content: 'hello' }] }),
    getToken: async () => `token-${++token}`,
    upload: async ({ threadId, token: bearer, body }) => { uploads.push({ threadId, token: bearer, body }); },
    ...overrides,
  };
  installPassiveAmpThreadMirror(amp, deps);
  const emit = async (name: string, threadId: string) => {
    for (const handler of handlers.get(name) ?? []) await handler({ threadId }, { thread: { id: threadId } });
  };
  return { handlers, uploads, emit };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((settle) => { resolve = settle; }), resolve };
}

describe('passive Amp thread mirror', () => {
  test('registers only supported passive lifecycle events and full snapshots at correctness boundaries', async () => {
    const { handlers, uploads, emit } = harness();
    expect([...handlers.keys()].sort()).toEqual(['agent.end', 'message_added', 'message_updated', 'session.start']);

    await emit('session.start', 'T-one');
    await emit('agent.end', 'T-one');

    expect(uploads).toHaveLength(2);
    expect(uploads.every(({ body }) => JSON.stringify(body).includes('hello'))).toBe(true);
    expect(uploads.map(({ token }) => token)).toEqual(['token-1', 'token-2']);
  });

  test('rejects an export whose top-level thread id differs before upload', async () => {
    const { uploads, emit } = harness({ exportThread: async () => ({ id: 'T-other', messages: [] }) });
    await emit('agent.end', 'T-requested');
    expect(uploads).toEqual([]);
  });

  test('retries retryable failures with a fresh token but treats 4xx as terminal', async () => {
    const tokens: string[] = [];
    let attempt = 0;
    const retrying = harness({
      upload: async ({ token }) => {
        tokens.push(token);
        if (++attempt === 1) throw Object.assign(new Error('busy'), { status: 503 });
      },
      sleep: async () => undefined,
    });
    await retrying.emit('agent.end', 'T-retry');
    expect(tokens).toEqual(['token-1', 'token-2']);

    let terminalAttempts = 0;
    const terminal = harness({
      upload: async () => {
        terminalAttempts += 1;
        throw Object.assign(new Error('bad'), { status: 400 });
      },
      sleep: async () => undefined,
    });
    await terminal.emit('agent.end', 'T-terminal');
    expect(terminalAttempts).toBe(1);
  });

  test('serializes one thread while allowing different threads to upload independently', async () => {
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    const { emit } = harness({
      upload: ({ threadId }) => new Promise<void>((resolve) => {
        started.push(threadId);
        releases.set(threadId, resolve);
      }),
    });
    const first = emit('message_added', 'T-a');
    const queued = emit('agent.end', 'T-a');
    const independent = emit('agent.end', 'T-b');
    await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual(['T-a', 'T-b']);
    releases.get('T-b')?.(); await independent;
    releases.get('T-a')?.(); await first;
    await Promise.resolve();
    expect(started).toEqual(['T-a', 'T-b', 'T-a']);
    releases.get('T-a')?.(); await queued;
  });

  test('settles timed-out hooks but retains queue occupancy until underlying work terminates', async () => {
    const blocked = deferred();
    const exports: string[] = [];
    const { emit } = harness({
      deadlineMs: 5,
      exportThread: async (threadId) => {
        exports.push(threadId);
        if (threadId === 'T-a' && exports.filter((id) => id === 'T-a').length === 1) await blocked.promise;
        return { id: threadId, messages: [] };
      },
    });

    const timedOut = emit('message_added', 'T-a');
    const queued = emit('agent.end', 'T-a');
    const independent = emit('agent.end', 'T-b');
    await Promise.all([timedOut, queued, independent]);
    expect(exports).toEqual(['T-a', 'T-b']);

    blocked.resolve();
    await Bun.sleep(0);
    expect(exports).toEqual(['T-a', 'T-b', 'T-a']);
  });

  test('serializes enrollment first, gates its snapshot on success, and suppresses it on failure', async () => {
    const enrollment = deferred();
    const order: string[] = [];
    const successful = harness({
      beforeSessionStart: async () => { order.push('enroll'); await enrollment.promise; order.push('enrolled'); },
      exportThread: async (threadId) => { order.push(`export:${threadId}`); return { id: threadId, messages: [] }; },
    });
    const start = successful.emit('session.start', 'T-enroll');
    const message = successful.emit('message_added', 'T-enroll');
    await Promise.resolve();
    expect(order).toEqual(['enroll']);
    enrollment.resolve();
    await Promise.all([start, message]);
    expect(order).toEqual(['enroll', 'enrolled', 'export:T-enroll', 'export:T-enroll']);

    const failed = harness({ beforeSessionStart: async () => { throw new Error('denied'); } });
    await failed.emit('session.start', 'T-failed');
    expect(failed.uploads).toEqual([]);
  });
});
