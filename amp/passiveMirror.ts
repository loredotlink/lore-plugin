import type { PluginAPI } from '@ampcode/plugin';

type JsonRecord = Record<string, unknown>;
export type AmpThreadExport = { id?: unknown; title?: unknown; messages?: unknown; created?: unknown; updatedAt?: unknown };
export type PassiveUpload = { threadId: string; token: string; body: JsonRecord };

export type PassiveMirrorDeps = {
  exportThread: (threadId: string, ctx: unknown) => Promise<AmpThreadExport>;
  getToken: (threadId: string, ctx: unknown) => Promise<string>;
  upload: (request: PassiveUpload, signal: AbortSignal) => Promise<void>;
  beforeSessionStart?: (threadId: string, ctx: unknown, signal: AbortSignal) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  deadlineMs?: number;
  maxAttempts?: number;
};

type Work = { full: boolean; ctx: unknown; event: unknown; trigger: string; settle: () => void };
type ThreadQueue = { running: boolean; pending: Work[] };

const PASSIVE_EVENTS = ['session.start', 'agent.end'] as const;
const THREAD_MESSAGE_PAGE_SIZE = 20;

export function installPassiveAmpThreadMirror(amp: PluginAPI, deps: PassiveMirrorDeps): void {
  const eventApi = amp as unknown as { on?: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => void };
  if (typeof eventApi.on !== 'function') {
    amp.logger.log('[lore] passive mirror status=disabled category=events_unavailable');
    return;
  }
  const queues = new Map<string, ThreadQueue>();
  for (const eventName of PASSIVE_EVENTS) {
    eventApi.on(eventName, async (event, ctx) => {
      const threadId = resolveThreadId(event, ctx);
      if (!threadId) return;
      const completion = enqueue(queues, threadId, {
        full: eventName === 'session.start' || eventName === 'agent.end', ctx, event, trigger: eventName,
        settle: () => undefined,
      }, amp, deps);
      await withDeadline(completion, deps.deadlineMs ?? 15_000).catch((error) => {
        logStatus(amp, eventName, threadId, 'failed', retryCategory(error));
      });
    });
  }
}

function enqueue(queues: Map<string, ThreadQueue>, threadId: string, work: Work, amp: PluginAPI, deps: PassiveMirrorDeps): Promise<void> {
  const queue = queues.get(threadId) ?? { running: false, pending: [] };
  queues.set(threadId, queue);
  return new Promise((resolve) => {
    work.settle = resolve;
    const last = queue.pending.at(-1);
    // Enrollment is an ordering barrier and can neither supersede nor be
    // superseded. Otherwise a queued full snapshot makes incrementals redundant.
    if (work.trigger !== 'session.start' && last?.trigger !== 'session.start') {
      if (last?.full && !work.full) {
        resolve();
        return;
      }
      if (work.full) {
        while (queue.pending.length && queue.pending.at(-1)?.trigger !== 'session.start') {
          queue.pending.pop()?.settle();
        }
      }
    }
    queue.pending.push(work);
    if (!queue.running) void drain(queues, threadId, queue, amp, deps);
  });
}

async function drain(queues: Map<string, ThreadQueue>, threadId: string, queue: ThreadQueue, amp: PluginAPI, deps: PassiveMirrorDeps): Promise<void> {
  queue.running = true;
  while (queue.pending.length) {
    const work = queue.pending.shift()!;
    try {
      await mirrorOnce(threadId, work, amp, deps);
    } catch (error) {
      logStatus(amp, work.trigger, threadId, 'failed', retryCategory(error));
    } finally {
      work.settle();
    }
  }
  queue.running = false;
  queues.delete(threadId);
}

async function mirrorOnce(threadId: string, work: Work, amp: PluginAPI, deps: PassiveMirrorDeps): Promise<void> {
  if (work.trigger === 'session.start' && deps.beforeSessionStart) {
    const signal = AbortSignal.timeout(deps.deadlineMs ?? 15_000);
    await deps.beforeSessionStart(threadId, work.ctx, signal);
  }
  if (
    work.trigger === 'agent.end' &&
    (!isRecord(work.event) || work.event.status !== 'done')
  ) return;
  const thread = await deps.exportThread(threadId, work.ctx);
  if (stringOrNull(thread.id) !== threadId) {
    logStatus(amp, work.trigger, threadId, 'rejected', 'thread_mismatch');
    return;
  }
  const body = buildFullSnapshot(thread);
  const attempts = Math.max(1, deps.maxAttempts ?? 3);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const token = await deps.getToken(threadId, work.ctx);
      await deps.upload({ threadId, token, body }, AbortSignal.timeout(deps.deadlineMs ?? 15_000));
      logStatus(amp, work.trigger, threadId, 'uploaded', attempt > 1 ? 'retried' : 'none');
      return;
    } catch (error) {
      if (!isRetryable(error) || attempt === attempts) throw error;
      logStatus(amp, work.trigger, threadId, 'retry', retryCategory(error));
      await (deps.sleep ?? delay)(100 * 2 ** (attempt - 1));
    }
  }
}

export async function readPluginThreadSnapshot(threadId: string, ctx: unknown): Promise<AmpThreadExport> {
  const thread = isRecord(ctx) && isRecord(ctx.thread) ? ctx.thread : null;
  if (
    !thread ||
    stringOrNull(thread.id) !== threadId ||
    typeof thread.messages !== 'function'
  ) throw new Error('thread_messages_unavailable');

  const readMessages = thread.messages as (options: JsonRecord) => Promise<unknown>;
  const messages: JsonRecord[] = [];
  for (let offset = 0; ; offset += THREAD_MESSAGE_PAGE_SIZE) {
    const page = await readMessages.call(thread, {
      full: true,
      from: 'start',
      offset,
      limit: THREAD_MESSAGE_PAGE_SIZE,
      roles: ['user', 'assistant'],
    });
    if (!Array.isArray(page)) throw new Error('thread_messages_invalid');
    messages.push(...page.filter(isRecord).map(normalizePluginMessage));
    if (page.length < THREAD_MESSAGE_PAGE_SIZE) break;
  }

  const title = isRecord(thread.title) && typeof thread.title.get === 'function'
    ? stringOrNull(await (thread.title.get as () => Promise<unknown>)())
    : null;
  return {
    id: threadId,
    ...(title ? { title } : {}),
    updatedAt: new Date().toISOString(),
    messages,
  };
}

function normalizePluginMessage(message: JsonRecord): JsonRecord {
  const role = stringOrNull(message.role);
  const content = Array.isArray(message.content)
    ? message.content.filter(isRecord).map((part) => ({ ...part, blockState: 'complete' }))
    : [];
  return {
    ...message,
    messageId: message.messageId ?? message.id,
    content,
    ...(role === 'assistant' ? { state: { type: 'complete' } } : {}),
  };
}

export function buildFullSnapshot(thread: AmpThreadExport): JsonRecord {
  const threadId = stringOrNull(thread.id);
  if (!threadId) return { resourceLogs: [] };
  const messages = Array.isArray(thread.messages) ? thread.messages.filter(isRecord) : [];
  const fallback = isoTimestamp(thread.updatedAt) ?? isoTimestamp(thread.created) ?? new Date(0).toISOString();
  const records: JsonRecord[] = [{
    timeUnixNano: toUnixNano(fallback),
    attributes: attributes({ 'event.name': 'amp.export.thread', 'event.sequence': 0, 'session.id': threadId, 'amp.export.kind': 'thread' }),
    body: anyValue({ ...thread, messages: undefined, messageCount: messages.length }),
  }];
  messages.forEach((message, index) => {
    const role = stringOrNull(message.role) ?? '';
    const timestamp = isoTimestamp(isRecord(message.meta) ? message.meta.sentAt : undefined) ?? fallback;
    const promptId = stringOrNull(message.messageId)
      ?? (typeof message.messageId === 'number' && Number.isFinite(message.messageId) ? String(message.messageId) : null)
      ?? `amp-msg-${index}`;
    const prompt = role === 'user' ? textContent(message.content) : null;
    const assistant = role === 'assistant' ? assistantResponseBody(message, promptId) : null;
    if (!role || (role === 'user' && !prompt) || (role === 'assistant' && !assistant)) return;
    records.push({
      timeUnixNano: toUnixNano(timestamp),
      attributes: attributes({
        'event.name': prompt ? 'claude_code.user_prompt' : assistant ? 'claude_code.api_response_body' : 'amp.export.message',
        'event.sequence': index + 1, 'session.id': threadId, 'prompt.id': promptId,
        'amp.export.kind': 'message', 'amp.message.index': index, 'amp.message.role': role,
        ...(prompt ? { prompt } : {}),
      }),
      body: anyValue(prompt ?? assistant ?? message),
    });
  });
  return { resourceLogs: [{
    resource: { attributes: attributes({ 'service.name': 'amp', 'service.namespace': 'lore.amp-plugin' }) },
    scopeLogs: [{ scope: { name: 'lore.amp-plugin.passive-thread-upload' }, logRecords: records }],
  }] };
}

function textContent(content: unknown): string | null {
  if (typeof content === 'string') return stringOrNull(content);
  if (!Array.isArray(content)) return null;
  const text = content
    .filter(isRecord)
    .filter((part) => part.type === 'text')
    .map((part) => stringOrNull(part.text))
    .filter((part): part is string => part !== null)
    .join('\n\n');
  return stringOrNull(text);
}

function assistantResponseBody(message: JsonRecord, promptId: string): JsonRecord | null {
  const content = Array.isArray(message.content)
    ? message.content.filter(isRecord)
    : typeof message.content === 'string' && message.content.trim()
      ? [{ type: 'text', text: message.content }]
      : [];
  const state = isRecord(message.state) ? stringOrNull(message.state.type) : null;
  const contentIsComplete = content.every((part) => part.blockState === 'complete');
  if (content.length === 0 || state !== 'complete' || !contentIsComplete) return null;
  const usage = isRecord(message.usage) ? message.usage : {};
  return {
    id: promptId,
    model: stringOrNull(usage.model) ?? 'amp',
    type: 'message',
    role: 'assistant',
    content,
    usage: {
      input_tokens: finiteNumber(usage.inputTokens) ?? 0,
      output_tokens: finiteNumber(usage.outputTokens) ?? 0,
      cache_creation_input_tokens: finiteNumber(usage.cacheCreationInputTokens) ?? 0,
      cache_read_input_tokens: finiteNumber(usage.cacheReadInputTokens) ?? 0,
      inference_geo: '',
      service_tier: '',
      cache_creation: {},
    },
  };
}

function resolveThreadId(event: unknown, ctx: unknown): string | null {
  if (isRecord(event)) {
    const direct = stringOrNull(event.threadId) ?? stringOrNull(event.thread_id);
    if (direct) return direct;
    if (isRecord(event.thread)) return stringOrNull(event.thread.id);
  }
  return isRecord(ctx) && isRecord(ctx.thread) ? stringOrNull(ctx.thread.id) : null;
}

function attributes(record: JsonRecord): JsonRecord[] {
  return Object.entries(record).map(([key, value]) => ({ key, value: anyValue(value) }));
}
function anyValue(value: unknown): JsonRecord {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(anyValue) } };
  if (isRecord(value)) return { kvlistValue: { values: Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => ({ key, value: anyValue(item) })) } };
  return { stringValue: value == null ? '' : String(value) };
}
function toUnixNano(timestamp: string): string { return (BigInt(Date.parse(timestamp)) * 1_000_000n).toString(); }
function isoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
function stringOrNull(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}
function isRecord(value: unknown): value is JsonRecord { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function statusOf(error: unknown): number | null { return isRecord(error) && typeof error.status === 'number' ? error.status : null; }
function isRetryable(error: unknown): boolean { const status = statusOf(error); return status === null || status === 429 || status >= 500; }
function retryCategory(error: unknown): string { const status = statusOf(error); return status === 429 ? 'rate_limited' : status && status >= 500 ? 'server' : status && status >= 400 ? 'terminal' : 'network'; }
function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function withDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('deadline')), milliseconds); })]).finally(() => clearTimeout(timer));
}
function logStatus(amp: PluginAPI, trigger: string, threadId: string, status: string, category: string): void {
  amp.logger.log(`[lore] passive mirror trigger=${trigger} thread=${threadId} status=${status} retry=${category}`);
}
