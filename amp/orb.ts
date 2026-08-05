import type { PluginAPI } from '@ampcode/plugin';

import { installPassiveAmpThreadMirror, type AmpThreadExport } from './passiveMirror.js';

export const AMP_ORB_AUDIENCE = 'urn:lore:amp-upload';

export type OrbPluginConfig = {
  loreApiOrigin: string;
  expectedAmpWorkspaceId: string;
  enrollmentChallenge?: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

type ShellResult = { exitCode: number; stdout: string; stderr: string };
type EventContext = { $?: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<ShellResult> };

export function createLoreOrbPlugin(config: OrbPluginConfig): (amp: PluginAPI) => void {
  const origin = config.loreApiOrigin.replace(/\/+$/, '');
  const request = config.fetch ?? globalThis.fetch;
  return (amp) => installPassiveAmpThreadMirror(amp, {
    exportThread: async (threadId, ctx) => {
      const shell = requireShell(ctx);
      const result = await shell`amp threads export ${threadId}`;
      if (result.exitCode !== 0) throw new Error('thread_export_failed');
      return JSON.parse(result.stdout) as AmpThreadExport;
    },
    getToken: (threadId, ctx) => mintToken(threadId, ctx, config.expectedAmpWorkspaceId),
    beforeSessionStart: config.enrollmentChallenge ? async (threadId, ctx, signal) => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const token = await mintToken(threadId, ctx, config.expectedAmpWorkspaceId);
          await post(request, `${origin}/api/amp/enrollment/completions`, token, { challenge: config.enrollmentChallenge }, signal);
          return;
        } catch (error) {
          const status = (error as { status?: unknown })?.status;
          if ((typeof status === 'number' && status >= 400 && status < 500 && status !== 429) || attempt === 3) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
        }
      }
    } : undefined,
    upload: async ({ token, body }, signal) => post(request, `${origin}/api/otel/v1/logs`, token, body, signal),
  });
}

async function mintToken(_threadId: string, ctx: unknown, expectedWorkspaceId: string): Promise<string> {
  const shell = requireShell(ctx);
  const result = await shell`amp orb id-token --audience ${AMP_ORB_AUDIENCE} --ttl-seconds ${60}`;
  const token = result.stdout.trim();
  if (result.exitCode !== 0 || !token) throw new Error('token_mint_failed');
  if (workspaceIdFromToken(token) !== expectedWorkspaceId) {
    throw Object.assign(new Error('token_workspace_mismatch'), { status: 400 });
  }
  return token;
}

function workspaceIdFromToken(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as unknown;
    return typeof payload === 'object' && payload !== null && typeof (payload as { workspace_id?: unknown }).workspace_id === 'string'
      ? (payload as { workspace_id: string }).workspace_id : null;
  } catch {
    return null;
  }
}

function requireShell(ctx: unknown): NonNullable<EventContext['$']> {
  const shell = (ctx as EventContext)?.$;
  if (typeof shell !== 'function') throw new Error('event_shell_unavailable');
  return shell;
}

async function post(fetcher: NonNullable<OrbPluginConfig['fetch']>, url: string, token: string, body: unknown, signal: AbortSignal): Promise<void> {
  const response = await fetcher(url, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-lore-harness': 'Amp' },
    body: JSON.stringify(body), signal,
  });
  if (!response.ok) throw Object.assign(new Error('http_request_failed'), { status: response.status });
}

export default createLoreOrbPlugin;
