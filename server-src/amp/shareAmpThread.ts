import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { toAmpToolResult, type AmpPluginTextContent, type AmpPluginToolDefinition } from './ampToolAdapter.js';
import { runShareSession } from '../tools/share_session.js';

const execFileAsync = promisify(execFile);

export type ShareAmpThreadArgs = {
  threadId?: string;
  activeThreadId?: string;
  visibility?: AmpShareVisibility;
  highlight?: string;
};

export type AmpShareVisibility = 'private' | 'workspace' | 'public';

export type ShareCurrentAmpThreadToolInput = {
  thread_id?: string;
  visibility?: AmpShareVisibility;
  highlight?: string;
};

export type ShareAmpThreadDeps = {
  runAmpExport: (threadId: string) => Promise<string>;
  share: (
    args: Record<string, unknown>,
    opts: { harness: 'amp' },
  ) => Promise<unknown>;
  ampBaseUrl?: URL;
  env?: NodeJS.ProcessEnv;
};

export type AmpShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type AmpShellFunction = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<AmpShellResult>;

export async function runAmpThreadExport(threadId: string): Promise<string> {
  const { stdout } = await execFileAsync('amp', ['threads', 'export', threadId], {
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout;
}

export async function runAmpThreadExportWithShell(
  threadId: string,
  shell: AmpShellFunction,
): Promise<string> {
  const result = await shell`amp threads export ${threadId}`;
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`amp threads export failed: ${detail}`);
  }
  return result.stdout;
}

export async function runShareAmpSession(
  args: Record<string, unknown>,
  opts: { harness: 'amp' },
): Promise<unknown> {
  return runShareSession(args, { harness: opts.harness });
}

export function createShareCurrentAmpThreadTool(deps: ShareAmpThreadDeps): AmpPluginToolDefinition {
  return {
    name: 'share_current_amp_thread',
    description:
      'Share an Amp thread to Lore. Pass thread_id explicitly when possible; otherwise AMP_CURRENT_THREAD_ID must be set.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        visibility: { type: 'string', enum: ['private', 'workspace', 'public'] },
        highlight: {
          type: 'string',
          description:
            'Natural-language description of the block or block range to highlight in the returned Lore URL.',
        },
      },
      additionalProperties: false,
    },
    execute: async (input: Record<string, unknown>, ctx: unknown) => {
      try {
        const result = await shareAmpThread(
          {
            threadId: optionalString(input.thread_id),
            activeThreadId: resolveToolContextThreadId(ctx),
            visibility: optionalVisibility(input.visibility),
            highlight: optionalString(input.highlight),
          },
          deps,
        );
        return toAmpToolResult(result);
      } catch (error) {
        return [
          {
            type: 'text',
            text: `Could not share the Amp thread to Lore. Pass thread_id explicitly, set AMP_CURRENT_THREAD_ID, or run the Lore share command from an active Amp thread. ${
              (error as Error).message
            }`,
          },
        ] satisfies AmpPluginTextContent[];
      }
    },
  };
}

export async function shareAmpThread(
  args: ShareAmpThreadArgs,
  deps: ShareAmpThreadDeps,
): Promise<unknown> {
  const threadId = firstNonEmpty(args.threadId, args.activeThreadId, deps.env?.AMP_CURRENT_THREAD_ID);
  if (!threadId) {
    throw new Error(
      'No active Amp thread could be resolved. Run this command from an active Amp thread (ctx.thread.id), set AMP_CURRENT_THREAD_ID, or pass thread_id explicitly.',
    );
  }

  const exportedJson = await deps.runAmpExport(threadId);
  const shareArgs: Record<string, unknown> = {
    transcript: exportedJson,
  };

  const title = extractTitle(exportedJson);
  if (title) {
    shareArgs.title = title;
  }

  const sourceUrl = buildAmpThreadUrl(deps.ampBaseUrl, threadId);
  if (sourceUrl) {
    shareArgs.source_url = sourceUrl;
  }

  if (args.visibility !== undefined) {
    shareArgs.visibility = args.visibility;
  }

  const highlight = args.highlight?.trim();
  if (highlight) {
    shareArgs.highlight = highlight;
  }

  return deps.share(shareArgs, { harness: 'amp' });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalVisibility(value: unknown): AmpShareVisibility | undefined {
  return value === 'private' || value === 'workspace' || value === 'public' ? value : undefined;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === 'string' && value.trim() !== '')?.trim();
}

function resolveToolContextThreadId(ctx: unknown): string | undefined {
  if (ctx === null || typeof ctx !== 'object') return undefined;
  const thread = (ctx as { thread?: unknown }).thread;
  if (thread === null || typeof thread !== 'object') return undefined;
  return optionalString((thread as { id?: unknown }).id);
}

function extractTitle(exportedJson: string): string | undefined {
  try {
    const parsed = JSON.parse(exportedJson) as { title?: unknown };
    if (typeof parsed.title !== 'string') return undefined;
    const title = parsed.title.trim();
    return title === '' ? undefined : title;
  } catch {
    return undefined;
  }
}

function buildAmpThreadUrl(baseUrl: URL | undefined, threadId: string): string | undefined {
  if (!baseUrl) return undefined;
  return new URL(`/threads/${encodeURIComponent(threadId)}`, baseUrl).toString();
}
