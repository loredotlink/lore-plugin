import { describe, expect, test } from 'bun:test';
import type { PluginAPI } from '@ampcode/plugin';

import {
  buildFullSnapshot,
  installPassiveAmpThreadMirror,
  readPluginThreadSnapshot,
  type PassiveMirrorDeps,
} from './passiveMirror';

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
    exportThread: async (threadId) => ({
      id: threadId,
      messages: [
        { role: 'user', messageId: 'm1', content: 'hello' },
        { role: 'assistant', messageId: 'm2', state: { type: 'complete' }, content: [{ type: 'text', text: 'done', blockState: 'complete' }] },
      ],
    }),
    getToken: async () => `token-${++token}`,
    upload: async ({ threadId, token: bearer, body }) => { uploads.push({ threadId, token: bearer, body }); },
    ...overrides,
  };
  installPassiveAmpThreadMirror(amp, deps);
  const emit = async (name: string, threadId: string) => {
    const event = name === 'agent.end'
      ? { thread: { id: threadId }, status: 'done', messages: [] }
      : { thread: { id: threadId } };
    for (const handler of handlers.get(name) ?? []) await handler(event, { thread: { id: threadId } });
  };
  return { handlers, uploads, emit };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((settle) => { resolve = settle; }), resolve };
}

function decodeAnyValue(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if ('stringValue' in record) return record.stringValue;
  if ('intValue' in record) return Number(record.intValue);
  if ('doubleValue' in record) return record.doubleValue;
  if ('boolValue' in record) return record.boolValue;
  if (typeof record.arrayValue === 'object' && record.arrayValue !== null) {
    const values = (record.arrayValue as { values?: unknown }).values;
    return Array.isArray(values) ? values.map(decodeAnyValue) : [];
  }
  if (typeof record.kvlistValue === 'object' && record.kvlistValue !== null) {
    const values = (record.kvlistValue as { values?: unknown }).values;
    if (!Array.isArray(values)) return {};
    return Object.fromEntries(values.map((entry) => {
      const attribute = entry as { key: string; value: unknown };
      return [attribute.key, decodeAnyValue(attribute.value)];
    }));
  }
  return value;
}

function snapshotRecords(snapshot: Record<string, unknown>): Array<Record<string, unknown>> {
  const resourceLogs = snapshot.resourceLogs as Array<{ scopeLogs: Array<{ logRecords: Array<Record<string, unknown>> }> }>;
  return resourceLogs[0]?.scopeLogs[0]?.logRecords ?? [];
}

describe('passive Amp thread mirror', () => {
  test('serializes finalized Amp messages as projector user and assistant records instead of system fallbacks', () => {
    const marker = 'desktop-amp-log-shipping-regression';
    const records = snapshotRecords(buildFullSnapshot({
      id: 'T-regression',
      created: 1_786_138_081_141,
      messages: [
        {
          meta: { sentAt: 1_786_138_085_964 },
          role: 'user',
          messageId: 1,
          content: [{ type: 'text', text: `${marker}. Reply with exactly "ok".` }],
        },
        {
          role: 'assistant',
          messageId: 2,
          state: { type: 'complete', stopReason: 'end_turn' },
          usage: { model: 'gpt-5.6-sol', inputTokens: 17, outputTokens: 5 },
          content: [{ type: 'text', text: 'ok', blockState: 'complete' }],
        },
      ],
    }));
    const decoded = records.map((record) => ({
      attributes: Object.fromEntries((record.attributes as Array<{ key: string; value: unknown }>).map((attribute) => [
        attribute.key,
        decodeAnyValue(attribute.value),
      ])),
      body: decodeAnyValue(record.body),
    }));

    expect(decoded.map(({ attributes }) => attributes['event.name'])).toEqual([
      'amp.export.thread',
      'claude_code.user_prompt',
      'claude_code.api_response_body',
    ]);
    expect(decoded[1]).toMatchObject({
      attributes: { 'prompt.id': '1', prompt: `${marker}. Reply with exactly "ok".` },
      body: `${marker}. Reply with exactly "ok".`,
    });
    expect(decoded[2]).toMatchObject({
      attributes: { 'prompt.id': '2' },
      body: {
        id: '2',
        model: 'gpt-5.6-sol',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 17, output_tokens: 5 },
      },
    });
  });

  test('reads the finalized full transcript from the stable plugin API shape', async () => {
    const marker = 'desktop-amp-log-shipping-plugin-api';
    const calls: unknown[] = [];
    const thread = await readPluginThreadSnapshot('T-finalized', {
      thread: {
        id: 'T-finalized',
        title: { get: async () => 'Finalized thread' },
        messages: async (options: unknown) => {
          calls.push(options);
          return [
            { id: 1, role: 'user', content: [{ type: 'text', text: marker }] },
            { id: 2, role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
          ];
        },
      },
    });

    expect(calls).toEqual([{
      full: true,
      from: 'start',
      offset: 0,
      limit: 20,
      roles: ['user', 'assistant'],
    }]);
    const eventNames = snapshotRecords(buildFullSnapshot(thread)).map((record) => {
      const eventName = (record.attributes as Array<{ key: string; value: unknown }>).find(({ key }) => key === 'event.name');
      return decodeAnyValue(eventName?.value);
    });
    expect(eventNames).toEqual([
      'amp.export.thread',
      'claude_code.user_prompt',
      'claude_code.api_response_body',
    ]);
    expect(JSON.stringify(thread)).toContain(marker);
    expect(JSON.stringify(thread)).toContain('ok');
  });

  test('registers only supported passive lifecycle events and full snapshots at correctness boundaries', async () => {
    const { handlers, uploads, emit } = harness();
    expect([...handlers.keys()].sort()).toEqual(['agent.end', 'session.start']);

    await emit('session.start', 'T-one');
    await emit('agent.end', 'T-one');

    expect(uploads).toHaveLength(2);
    expect(uploads.every(({ body }) => JSON.stringify(body).includes('hello'))).toBe(true);
    expect(uploads.map(({ token }) => token)).toEqual(['token-1', 'token-2']);
  });

  test('does not snapshot a failed or cancelled agent turn as completed', async () => {
    let reads = 0;
    const { handlers, uploads } = harness({
      exportThread: async (threadId) => {
        reads += 1;
        return { id: threadId, messages: [] };
      },
    });
    for (const status of ['error', 'cancelled']) {
      await handlers.get('agent.end')?.[0]?.({
        thread: { id: `T-${status}` },
        status,
        messages: [],
      }, { thread: { id: `T-${status}` } });
    }

    expect(reads).toBe(0);
    expect(uploads).toEqual([]);
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
    const first = emit('agent.end', 'T-a');
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
        return {
          id: threadId,
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'hello' }] },
            { role: 'assistant', state: { type: 'complete' }, content: [{ type: 'text', text: 'done', blockState: 'complete' }] },
          ],
        };
      },
    });

    const timedOut = emit('agent.end', 'T-a');
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
    const message = successful.emit('agent.end', 'T-enroll');
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
