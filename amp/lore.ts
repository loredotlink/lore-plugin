import type { PluginAPI, PluginCommandContext } from '@ampcode/plugin';

import { toAmpToolDefinition } from '../server-src/amp/ampToolAdapter.js';
import {
  createShareCurrentAmpThreadTool,
  runAmpThreadExport,
  runAmpThreadExportWithShell,
  runShareAmpSession,
  shareAmpThread,
  type ShareAmpThreadDeps,
} from '../server-src/amp/shareAmpThread.js';
import { tools } from '../server-src/tools/index.js';

const SHARE_COMMAND_ID = 'lore.share-active-amp-thread';
const SAFE_AMP_TOOL_NAMES = new Set([
  'lore_login',
  'lore_login_resume',
  'get_thread',
  'list_threads',
  'fork_thread',
  'search_threads',
]);

type ShareActiveThreadDeps = ShareAmpThreadDeps;

export default function loreAmpPlugin(amp: PluginAPI): void {
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
      runAmpExport: runAmpThreadExport,
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
