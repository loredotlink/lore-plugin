import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { PluginAPI, PluginCommandContext } from '@ampcode/plugin';

import { toAmpToolDefinition } from '../server-src/amp/ampToolAdapter.js';
import {
  createShareCurrentAmpThreadTool,
  runAmpThreadExportWithShell,
  runShareAmpSession,
  shareAmpThread,
  type ShareAmpThreadDeps,
} from '../server-src/amp/shareAmpThread.js';
import { getValidAccessToken } from '../server-src/lib/auth/refresh.js';
import { tools } from '../server-src/tools/index.js';

const SHARE_COMMAND_ID = 'lore.share-active-amp-thread';
const PASSIVE_MIRROR_SERVICE_NAME = 'amp';
const SAFE_AMP_TOOL_NAMES = new Set([
  'lore_login',
  'lore_login_resume',
  'get_thread',
  'list_threads',
  'fork_thread',
  'search_threads',
]);

type ShareActiveThreadDeps = ShareAmpThreadDeps;
type JsonRecord = Record<string, unknown>;
type ShellResult = { exitCode: number; stdout: string; stderr: string };
type PendingToolCall = { name: string; input: unknown };
type AmpContentBlock = {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  toolUseId?: unknown;
  toolUseID?: unknown;
  content?: unknown;
  output?: unknown;
  result?: unknown;
  run?: unknown;
  is_error?: unknown;
};
type AmpMessage = {
  role?: unknown;
  messageId?: unknown;
  content?: unknown;
  meta?: { sentAt?: unknown } & JsonRecord;
  usage?: { timestamp?: unknown } & JsonRecord;
};
type AmpThreadExport = {
  id?: unknown;
  title?: unknown;
  messages?: unknown;
  created?: unknown;
  updatedAt?: unknown;
};
type PendingUploadBatch = {
  messageFingerprints: string[];
  records: JsonRecord[];
};

const uploadedMessageFingerprintsByThread = new Map<string, string[]>();
const pendingUploadByThread = new Map<string, PendingUploadBatch>();
const mirrorPromiseByThread = new Map<string, Promise<void>>();
const RUNTIME_EVENT_NAMES = [
  'agent.start',
  'agent_state',
  'compaction_complete',
  'compaction_started',
  'delta',
  'executor_connected',
  'executor_guidance_discovery',
  'executor_status',
  'executor_tool_lease_ack',
  'executor_tool_result',
  'executor_tool_result_ack',
  'executor_workspace_maybe_changed',
  'inference_tools',
  'message_added',
  'message_updated',
  'observers',
  'plugin_message',
  'queued_message_added',
  'queued_message_dequeued',
  'queued_messages',
  'thread_settings',
  'thread_title',
  'tool_lease',
  'tool_progress',
] as const;

const INSTALLED_AMP_PLUGIN_SUFFIXES = [
  `${path.sep}harness${path.sep}amp${path.sep}lore-plugin${path.sep}amp${path.sep}lore-bundled.js`,
  `${path.sep}harness${path.sep}amp${path.sep}lore-plugin${path.sep}amp${path.sep}lore.ts`,
];

export function inferLoreStateDirFromAmpPluginUrl(importMetaUrl: string): string | null {
  let pluginFile: string;
  try {
    pluginFile = fileURLToPath(importMetaUrl);
  } catch {
    return null;
  }
  try {
    pluginFile = fs.realpathSync(pluginFile);
  } catch {
    // If Amp ever loads a non-filesystem URL or an already-removed plugin file,
    // fall back to checking the original path before giving up.
  }

  const suffix = INSTALLED_AMP_PLUGIN_SUFFIXES.find((candidate) => pluginFile.endsWith(candidate));
  if (!suffix) return null;
  return pluginFile.slice(0, -suffix.length);
}

function inferLoreStateDirFromAmpConfig(home: string, env: NodeJS.ProcessEnv): string | null {
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const configHome = xdgConfigHome && path.isAbsolute(xdgConfigHome) ? xdgConfigHome : path.join(home, '.config');
  return inferLoreStateDirFromAmpPluginUrl(pathToFileURL(path.join(configHome, 'amp', 'plugins', 'lore.ts')).href);
}

function configureLoreStateDirForInstalledAmpPlugin(importMetaUrl: string): void {
  if (process.env.LORE_PLUGIN_STATE_DIR?.trim()) return;
  const inferred = inferLoreStateDirFromAmpPluginUrl(importMetaUrl) ??
    inferLoreStateDirFromAmpConfig(process.env.HOME || process.cwd(), process.env);
  if (inferred) process.env.LORE_PLUGIN_STATE_DIR = inferred;
}

configureLoreStateDirForInstalledAmpPlugin(import.meta.url);

export default function loreAmpPlugin(amp: PluginAPI): void {
  installPassiveAmpThreadMirror(amp);

  amp.registerCommand(
    SHARE_COMMAND_ID,
    {
      category: 'Lore',
      title: 'Share active Amp thread',
      description: 'Export the active Amp thread and share it to Lore.',
    },
    async (ctx) => {
      await shareActiveThread(ctx);
    },
  );

  amp.registerTool(
    createShareCurrentAmpThreadTool({
      env: process.env,
      runAmpExport: (threadId) => runAmpThreadExportWithShell(threadId, amp.$),
      share: runShareAmpSession,
      ampBaseUrl: amp.system.ampURL,
    }),
  );

  for (const tool of tools) {
    if (!SAFE_AMP_TOOL_NAMES.has(tool.name)) continue;
    amp.registerTool(toAmpToolDefinition(tool));
  }
}

export async function shareActiveThread(
  ctx: PluginCommandContext,
  deps: ShareActiveThreadDeps = {
    env: process.env,
    ampBaseUrl: ctx.system.ampURL,
    runAmpExport: (threadId) => runAmpThreadExportWithShell(threadId, ctx.$),
    share: runShareAmpSession,
  },
): Promise<void> {
  try {
    const result = await shareAmpThread(
      { threadId: ctx.thread?.id },
      deps,
    );

    const threadUrl = extractThreadUrl(result);
    if (threadUrl) {
      const appendError = await appendShareUrlToThread(ctx, threadUrl);
      const copiedToClipboard = await copyThreadUrlToClipboard(ctx, threadUrl);
      const details: string[] = [];

      if (!ctx.thread) {
        details.push('Amp did not expose an active thread to write into.');
      } else if (appendError) {
        details.push(`Amp could not write the URL into this thread: ${appendError}.`);
      }

      details.push(copiedToClipboard ? 'Copied Lore URL to clipboard.' : 'Could not copy Lore URL to clipboard.');

      if (!ctx.thread || appendError || !copiedToClipboard) {
        details.push(...(await showCopyableThreadUrl(ctx, threadUrl)));
      }

      await ctx.ui.notify(`Shared Amp thread to Lore: ${threadUrl}. ${details.join(' ')}`.trim());
      return;
    }

    await ctx.ui.notify(formatShareResult(result));
  } catch (error) {
    await ctx.ui.notify(`Failed to share Amp thread to Lore: ${(error as Error).message}`);
  }
}

async function copyThreadUrlToClipboard(ctx: PluginCommandContext, threadUrl: string): Promise<boolean> {
  try {
    const result = await ctx.$`sh -c ${'printf %s "$1" | pbcopy'} sh ${threadUrl}`;
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function showCopyableThreadUrl(ctx: PluginCommandContext, threadUrl: string): Promise<string[]> {
  try {
    await ctx.ui.input({
      title: 'Shared Amp thread to Lore',
      helpText: 'Copy the Lore URL below.',
      initialValue: threadUrl,
      submitButtonText: 'Done',
    });
    return [];
  } catch (error) {
    return [`Could not show copyable Lore URL dialog: ${(error as Error).message}.`];
  }
}

async function appendShareUrlToThread(ctx: PluginCommandContext, threadUrl: string): Promise<string | undefined> {
  if (!ctx.thread) return undefined;

  try {
    await ctx.thread.append([
      {
        type: 'user-message',
        content: `Shared this Amp thread to Lore: ${threadUrl}`,
      },
    ]);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

function installPassiveAmpThreadMirror(amp: PluginAPI): void {
  const pluginWithEvents = amp as unknown as {
    on?: (eventName: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) => void;
  };
  if (typeof pluginWithEvents.on !== 'function') {
    amp.logger.log('[lore] Amp plugin API does not expose events; passive thread upload disabled.');
    return;
  }

  pluginWithEvents.on('session.start', (event, ctx) => {
    const threadId = resolveThreadId(event, ctx);
    if (threadId && !uploadedMessageFingerprintsByThread.has(threadId)) {
      uploadedMessageFingerprintsByThread.set(threadId, []);
    }
    void postRuntimeEvent('session.start', event, ctx, amp);
  });

  for (const eventName of RUNTIME_EVENT_NAMES) {
    pluginWithEvents.on(eventName, (event, ctx) => {
      void postRuntimeEvent(eventName, event, ctx, amp);
    });
  }

  pluginWithEvents.on('message_added', async (event, ctx) => {
    await enqueueAmpThreadMirror(event, ctx, amp, 'message_added');
  });

  pluginWithEvents.on('message_updated', async (event, ctx) => {
    await enqueueAmpThreadMirror(event, ctx, amp, 'message_updated');
  });

  pluginWithEvents.on('agent.end', async (event, ctx) => {
    await postRuntimeEvent('agent.end', event, ctx, amp);
    await enqueueAmpThreadMirror(event, ctx, amp, 'agent.end');
  });
}

async function postRuntimeEvent(eventName: string, event: unknown, ctx: unknown, amp: PluginAPI): Promise<void> {
  const runtimeRecord = runtimeRecordForEvent(eventName, event, ctx);
  if (!runtimeRecord) return;
  try {
    await postPassiveLogs([runtimeRecord.record]);
  } catch (error) {
    amp.logger.log(
      `[lore] Failed to upload Amp runtime event ${eventName} for ${runtimeRecord.threadId} to Lore: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function enqueueAmpThreadMirror(
  event: unknown,
  ctx: unknown,
  amp: PluginAPI,
  trigger: string,
): Promise<void> {
  const threadId = resolveThreadId(event, ctx);
  if (!threadId) return Promise.resolve();

  const previous = mirrorPromiseByThread.get(threadId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => mirrorAmpThread(threadId, ctx, amp, trigger));
  const tracked = next.finally(() => {
    if (mirrorPromiseByThread.get(threadId) === tracked) {
      mirrorPromiseByThread.delete(threadId);
    }
  });
  mirrorPromiseByThread.set(threadId, tracked);
  return tracked;
}

async function mirrorAmpThread(
  threadId: string,
  ctx: unknown,
  amp: PluginAPI,
  trigger: string,
): Promise<void> {
  const commandContext = ctx as {
    $?: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<ShellResult>;
  };
  if (typeof commandContext.$ !== 'function') {
    amp.logger.log(`[lore] Missing shell context while exporting Amp thread ${threadId}.`);
    return;
  }

  const pendingUpload = pendingUploadByThread.get(threadId);
  if (pendingUpload) {
    try {
      await postPassiveLogs(pendingUpload.records);
      uploadedMessageFingerprintsByThread.set(threadId, pendingUpload.messageFingerprints);
      pendingUploadByThread.delete(threadId);
    } catch (error) {
      amp.logger.log(
        `[lore] Failed to retry Amp thread ${threadId} to Lore: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
  }

  try {
    const exportResult = await commandContext.$`amp threads export ${threadId}`;
    if (exportResult.exitCode !== 0) {
      const detail = exportResult.stderr.trim() || exportResult.stdout.trim() || `exit code ${exportResult.exitCode}`;
      throw new Error(`amp threads export failed: ${detail}`);
    }
    const thread = JSON.parse(exportResult.stdout) as AmpThreadExport;
    if (stringOrNull(thread.id) !== threadId) thread.id = threadId;
    const previousMessageFingerprints = uploadedMessageFingerprintsByThread.get(threadId) ?? [];
    const { records, messageFingerprints } = buildPassiveLogRecords(thread, previousMessageFingerprints);
    if (records.length === 0) {
      uploadedMessageFingerprintsByThread.set(threadId, messageFingerprints);
      return;
    }
    try {
      await postPassiveLogs(records);
      uploadedMessageFingerprintsByThread.set(threadId, messageFingerprints);
      pendingUploadByThread.delete(threadId);
    } catch (error) {
      pendingUploadByThread.set(threadId, { messageFingerprints, records });
      throw error;
    }
  } catch (error) {
    amp.logger.log(
      `[lore] Failed to upload Amp thread ${threadId} to Lore after ${trigger}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function resolveThreadId(event: unknown, ctx: unknown): string | null {
  if (isRecord(event)) {
    const direct = stringOrNull(event.threadId) ?? stringOrNull(event.thread_id);
    if (direct) return direct;
  }
  if (isRecord(event) && isRecord(event.thread)) {
    const fromEvent = stringOrNull(event.thread.id);
    if (fromEvent) return fromEvent;
  }
  if (isRecord(ctx) && isRecord(ctx.thread)) {
    const fromContext = stringOrNull(ctx.thread.id);
    if (fromContext) return fromContext;
  }
  return null;
}

function runtimeRecordForEvent(eventName: string, event: unknown, ctx: unknown): {
  threadId: string;
  record: JsonRecord;
} | null {
  const threadId = resolveThreadId(event, ctx);
  if (!threadId) return null;
  const eventRecord = isRecord(event) ? event : {};
  const contextRecord = isRecord(ctx) ? ctx : {};
  const messageId =
    firstRuntimeString(eventRecord, ['messageId', 'messageID', 'id']) ??
    firstRuntimeString(contextRecord, ['messageId', 'messageID']);
  const timestamp =
    isoTimestamp(eventRecord['@timestamp']) ??
    isoTimestamp(eventRecord.timestamp) ??
    isoTimestamp(eventRecord.time) ??
    new Date().toISOString();
  const attributes: JsonRecord = {
    'event.name': `amp.${eventName}`,
    'session.id': threadId,
    'amp.event.name': eventName,
  };
  const sequence = firstRuntimeNumber(eventRecord, ['seq', 'sequence']);
  if (sequence !== null) attributes['event.sequence'] = sequence;
  const subtype = firstRuntimeString(eventRecord, ['subtype']);
  if (subtype) attributes['amp.event.subtype'] = subtype;
  const toolCallId = firstRuntimeString(eventRecord, ['toolCallId', 'tool_call_id']);
  if (toolCallId) attributes.tool_use_id = toolCallId;
  const toolName = firstRuntimeString(eventRecord, ['toolName', 'tool_name']);
  if (toolName) attributes.tool_name = toolName;
  if (messageId) attributes['prompt.id'] = messageId;
  const records: JsonRecord[] = [];
  pushLogRecord({
    records,
    timestamp,
    attributes,
    body: event,
  });
  const [record] = records;
  if (!record) return null;
  return { threadId, record };
}

function firstRuntimeString(record: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = stringOrNull(record[key]);
    if (value) return value;
  }
  return null;
}

function firstRuntimeNumber(record: JsonRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function buildPassiveLogRecords(thread: AmpThreadExport, previousMessageFingerprints: string[]): {
  records: JsonRecord[];
  messageFingerprints: string[];
} {
  const threadId = stringOrNull(thread.id);
  if (!threadId) return { records: [], messageFingerprints: [] };
  const messages = Array.isArray(thread.messages)
    ? (thread.messages.filter(isRecord) as AmpMessage[])
    : [];
  const messageCount = messages.length;
  const messageFingerprints = messages.map(messageFingerprint);
  const startIndex = firstChangedMessageIndex(previousMessageFingerprints, messageFingerprints);
  if (startIndex >= messageCount) return { records: [], messageFingerprints };

  const fallbackTimestamp = isoTimestamp(thread.updatedAt) ?? isoTimestamp(thread.created) ?? new Date().toISOString();
  const pendingToolCalls = preloadToolCalls(messages, startIndex);
  const records: JsonRecord[] = [];

  if (startIndex === 0) {
    pushLogRecord({
      records,
      timestamp: fallbackTimestamp,
      attributes: {
        'event.name': 'amp.export.thread',
        'event.sequence': 0,
        'session.id': threadId,
        'amp.export.kind': 'thread',
      },
      body: compactThreadMetadata(thread, messageCount),
    });
  }

  for (let index = startIndex; index < messageCount; index += 1) {
    const message = messages[index];
    const timestamp = messageTimestamp(message, fallbackTimestamp);
    const promptId = stringOrNull(message.messageId) ?? `amp-msg-${index}`;
    const sequence = index + 1;
    const role = stringOrNull(message.role) ?? '';

    pushLogRecord({
      records,
      timestamp,
      attributes: {
        'event.name': 'amp.export.message',
        'event.sequence': sequence,
        'session.id': threadId,
        'prompt.id': promptId,
        'amp.export.kind': 'message',
        'amp.message.index': index,
        'amp.message.role': role,
      },
      body: copyRecordWithoutKeys(message as JsonRecord, ['content']),
    });

    if (Array.isArray(message.content)) {
      for (let blockIndex = 0; blockIndex < message.content.length; blockIndex += 1) {
        const part = message.content[blockIndex];
        if (!isRecord(part)) continue;
        const blockType = stringOrNull(part.type) ?? 'unknown';
        const toolUseId = toolUseIdFromPart(part as AmpContentBlock);
        const blockAttributes: JsonRecord = {
          'event.name': `amp.export.block.${blockType}`,
          'event.sequence': sequence,
          'session.id': threadId,
          'prompt.id': promptId,
          'amp.export.kind': 'block',
          'amp.message.index': index,
          'amp.message.role': role,
          'amp.block.index': blockIndex,
          'amp.block.type': blockType,
        };
        if (toolUseId) blockAttributes.tool_use_id = toolUseId;
        const toolName = stringOrNull(part.name);
        if (toolName) blockAttributes.tool_name = toolName;
        pushLogRecord({ records, timestamp, attributes: blockAttributes, body: part });
      }
    }

    if (role === 'user') {
      const promptText = extractText(message.content);
      if (promptText.trim().length > 0) {
        pushLogRecord({
          records,
          timestamp,
          attributes: {
            'event.name': 'claude_code.user_prompt',
            'event.sequence': sequence,
            'session.id': threadId,
            'prompt.id': promptId,
            prompt: promptText,
          },
          body: promptText,
        });
      }
    } else if (role === 'assistant') {
      const assistantParts = toAssistantParts(message.content, pendingToolCalls);
      if (assistantParts.length > 0) {
        pushLogRecord({
          records,
          timestamp,
          attributes: {
            'event.name': 'claude_code.api_response_body',
            'event.sequence': sequence,
            'session.id': threadId,
            'prompt.id': promptId,
            model: 'amp',
          },
          body: {
            id: promptId,
            model: 'amp',
            type: 'message',
            role: 'assistant',
            content: assistantParts,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              inference_geo: '',
              service_tier: '',
              cache_creation: {},
            },
          },
        });
      }
    }

    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== 'tool_result') continue;
      const toolUseId = toolUseIdFromPart(part as AmpContentBlock);
      if (!toolUseId) continue;
      const pendingToolCall = pendingToolCalls.get(toolUseId);
      pushLogRecord({
        records,
        timestamp,
        attributes: {
          'event.name': 'claude_code.tool_result',
          'event.sequence': sequence,
          'session.id': threadId,
          'prompt.id': promptId,
          tool_use_id: toolUseId,
          tool_name: pendingToolCall?.name ?? 'unknown',
          tool_input: pendingToolCall?.input ?? {},
          tool_output: toolOutputFromPart(part as AmpContentBlock),
          success: part.is_error !== true,
        },
        body: toolOutputFromPart(part as AmpContentBlock) ?? {},
      });
    }
  }

  return { records, messageFingerprints };
}

function firstChangedMessageIndex(previous: string[], current: string[]): number {
  const limit = Math.min(previous.length, current.length);
  for (let index = 0; index < limit; index += 1) {
    if (previous[index] !== current[index]) return index;
  }
  return previous.length === current.length ? current.length : limit;
}

function messageFingerprint(message: AmpMessage): string {
  try {
    return JSON.stringify(message);
  } catch {
    return String(message.messageId ?? '') + ':' + String(message.meta?.sentAt ?? '') + ':' + String(message.usage?.timestamp ?? '');
  }
}

async function postPassiveLogs(records: JsonRecord[]): Promise<void> {
  if (records.length === 0) return;
  const token = await getValidAccessToken();
  const response = await fetch(`${otelApiOrigin()}/api/otel/v1/logs`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-lore-harness': 'Amp',
    },
    body: JSON.stringify({
      resourceLogs: [
        {
          resource: {
            attributes: objectToAttributes({
              'service.name': PASSIVE_MIRROR_SERVICE_NAME,
              'service.namespace': 'lore.amp-plugin',
            }),
          },
          scopeLogs: [
            {
              scope: { name: 'lore.amp-plugin.passive-thread-upload' },
              logRecords: records,
            },
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Lore OTEL logs upload failed (${response.status}): ${body.slice(0, 500)}`);
  }
}

function otelApiOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.LORE_OTEL_API_ORIGIN?.trim() || env.LORE_API_ORIGIN?.trim() || env.LORE_MCP_PROXY_BASE_URL?.trim();
  return (configured || 'https://lore-api.tanagram.ai').replace(/\/+$/, '');
}

function preloadToolCalls(messages: AmpMessage[], limit: number): Map<string, PendingToolCall> {
  const pendingToolCalls = new Map<string, PendingToolCall>();
  for (let index = 0; index < limit; index += 1) {
    const message = messages[index];
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (!isRecord(part) || part.type !== 'tool_use') continue;
      const toolUseId = toolUseIdFromPart(part as AmpContentBlock);
      if (!toolUseId) continue;
      pendingToolCalls.set(toolUseId, {
        name: stringOrNull(part.name) ?? 'unknown',
        input: part.input,
      });
    }
  }
  return pendingToolCalls;
}

function compactThreadMetadata(thread: AmpThreadExport, messageCount: number): JsonRecord {
  return {
    ...copyRecordWithoutKeys(thread as JsonRecord, ['messages']),
    messageCount,
  };
}

function copyRecordWithoutKeys(record: JsonRecord, keysToOmit: string[]): JsonRecord {
  const copy: JsonRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (keysToOmit.includes(key)) continue;
    copy[key] = value;
  }
  return copy;
}

function messageTimestamp(message: AmpMessage, fallback: string): string {
  return isoTimestamp(message.usage?.timestamp) ?? isoTimestamp(message.meta?.sentAt) ?? fallback;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== 'text') continue;
    const text = stringOrNull(part.text);
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
}

function toAssistantParts(content: unknown, pendingToolCalls: Map<string, PendingToolCall>): JsonRecord[] {
  if (typeof content === 'string') {
    return content.trim().length > 0 ? [{ type: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const parts: JsonRecord[] = [];
  for (const entry of content) {
    if (!isRecord(entry)) continue;
    if (entry.type === 'text') {
      const text = stringOrNull(entry.text);
      if (text) parts.push({ type: 'text', text });
      continue;
    }
    if (entry.type === 'tool_use') {
      const toolUseId = toolUseIdFromPart(entry as AmpContentBlock);
      const toolName = stringOrNull(entry.name) ?? 'unknown';
      const toolInput = isRecord(entry.input) ? entry.input : entry.input ?? {};
      if (toolUseId) pendingToolCalls.set(toolUseId, { name: toolName, input: toolInput });
      parts.push({
        type: 'tool_use',
        id: toolUseId ?? `toolu-${Math.random().toString(16).slice(2, 10)}`,
        name: toolName,
        input: toolInput,
        caller: { type: 'assistant' },
      });
    }
  }
  return parts;
}

function toolUseIdFromPart(part: AmpContentBlock): string | null {
  return stringOrNull(part.id) ?? stringOrNull(part.tool_use_id) ?? stringOrNull(part.toolUseId) ?? stringOrNull(part.toolUseID);
}

function toolOutputFromPart(part: AmpContentBlock): unknown {
  if (isRecord(part.run)) {
    if ('result' in part.run) return part.run.result;
    if ('output' in part.run) return part.run.output;
  }
  if ('content' in part) return part.content;
  if ('output' in part) return part.output;
  if ('result' in part) return part.result;
  return undefined;
}

function pushLogRecord(args: {
  records: JsonRecord[];
  timestamp: string;
  attributes: JsonRecord;
  body: unknown;
}) {
  const unixNano = toUnixNano(args.timestamp);
  args.records.push({
    timeUnixNano: unixNano,
    observedTimeUnixNano: unixNano,
    severityText: 'INFO',
    attributes: objectToAttributes(args.attributes),
    body: normalizeAnyValue(args.body),
  });
}

function objectToAttributes(value: JsonRecord): JsonRecord[] {
  return Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .map(([key, entry]) => ({ key, value: normalizeAnyValue(entry) }));
}

function normalizeAnyValue(value: unknown): JsonRecord {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isInteger(value)) return { intValue: String(value) };
    return { doubleValue: value };
  }
  if (typeof value === 'boolean') return { boolValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map((item) => normalizeAnyValue(item)) } };
  if (isRecord(value)) {
    return {
      kvlistValue: {
        values: Object.entries(value).map(([key, entry]) => ({ key, value: normalizeAnyValue(entry) })),
      },
    };
  }
  return { stringValue: '' };
}

function toUnixNano(timestamp: string): string {
  const millis = Date.parse(timestamp);
  if (!Number.isFinite(millis) || Number.isNaN(millis)) return String(BigInt(Date.now()) * 1_000_000n);
  return String(BigInt(Math.trunc(millis)) * 1_000_000n);
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    const asDate = new Date(millis);
    if (!Number.isNaN(asDate.getTime())) return asDate.toISOString();
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractThreadUrl(result: unknown): string | undefined {
  if (result === null || typeof result !== 'object') return undefined;

  const url = (result as { thread_url?: unknown }).thread_url;
  if (typeof url === 'string' && url.trim() !== '') return url;

  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;

  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if ((block as { type?: unknown }).type !== 'text') continue;

    const text = (block as { text?: unknown }).text;
    if (typeof text !== 'string' || text.trim() === '') continue;

    const parsedUrl = extractThreadUrlFromJsonText(text);
    if (parsedUrl) return parsedUrl;
  }

  return undefined;
}

function extractThreadUrlFromJsonText(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { thread_url?: unknown };
    const url = parsed.thread_url;
    return typeof url === 'string' && url.trim() !== '' ? url : undefined;
  } catch {
    return undefined;
  }
}

function formatShareResult(result: unknown): string {
  if (result !== null && typeof result === 'object' && Array.isArray((result as { content?: unknown }).content)) {
    const text = (result as { content: unknown[] }).content
      .map((block) => {
        if (
          block !== null &&
          typeof block === 'object' &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string'
        ) {
          return (block as { text: string }).text;
        }
        return JSON.stringify(block);
      })
      .join('\n');
    return text || 'Lore share returned no message.';
  }

  if (typeof result === 'string') return result;
  return `Lore share result: ${JSON.stringify(result)}`;
}
