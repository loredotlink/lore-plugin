import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginAPI } from '@ampcode/plugin';

import { AMP_ORB_AUDIENCE, createLoreOrbPlugin } from './orb';

function jwt(workspaceId: string, nonce?: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ workspace_id: workspaceId, nonce })}.signature`;
}

function pluginThread(id: string) {
  return {
    id,
    messages: async () => [
      { id: 1, role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { id: 2, role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ],
  };
}

describe('Lore Orb plugin', () => {
  test('uses event shell for exact-audience 60-second tokens and completes enrollment before upload', async () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
    const shellCalls: unknown[][] = [];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const amp = {
      on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => handlers.set(name, handler),
      logger: { log: () => undefined },
    } as unknown as PluginAPI;
    createLoreOrbPlugin({
      loreApiOrigin: 'https://lore.test/', expectedAmpWorkspaceId: 'workspace-1', enrollmentChallenge: 'challenge-secret',
      fetch: async (input, init) => { requests.push({ url: String(input), init }); return new Response('{}'); },
    })(amp);
    const ctx = {
      thread: pluginThread('T-orb'),
      $: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        shellCalls.push([...(strings as unknown as string[]), ...values]);
        return { exitCode: 0, stdout: jwt('workspace-1'), stderr: '' };
      },
    };
    await handlers.get('session.start')?.({ threadId: 'T-orb' }, ctx);

    expect(shellCalls.filter((call) => call.includes(AMP_ORB_AUDIENCE))).toHaveLength(2);
    expect(shellCalls.every((call) => !call.includes('workspace-1'))).toBe(true);
    expect(requests.map(({ url }) => url)).toEqual([
      'https://lore.test/api/amp/enrollment/completions',
      'https://lore.test/api/otel/v1/logs',
    ]);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ challenge: 'challenge-secret' });
  });

  test('mints a fresh token for a retryable enrollment attempt', async () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
    const tokens: string[] = [];
    let minted = 0;
    let enrollmentAttempts = 0;
    const amp = { on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => handlers.set(name, handler), logger: { log: () => undefined } } as unknown as PluginAPI;
    createLoreOrbPlugin({
      loreApiOrigin: 'https://lore.test', expectedAmpWorkspaceId: 'workspace', enrollmentChallenge: 'challenge',
      fetch: async (input, init) => {
        tokens.push(String((init?.headers as Record<string, string>).authorization));
        if (String(input).includes('completions') && ++enrollmentAttempts === 1) return new Response('', { status: 503 });
        return new Response('{}');
      },
    })(amp);
    const ctx = {
      thread: pluginThread('T-retry'),
      $: async () => ({ exitCode: 0, stdout: jwt('workspace', ++minted), stderr: '' }),
    };
    await handlers.get('session.start')?.({ threadId: 'T-retry' }, ctx);
    expect(tokens).toHaveLength(3);
    expect(new Set(tokens).size).toBe(3);
  });

  test('sends HTTP only for tokens whose workspace claim matches configuration', async () => {
    for (const [token, expectedRequests] of [[jwt('workspace'), 1], [jwt('other'), 0], ['malformed', 0]] as const) {
      const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
      let requests = 0;
      const amp = { on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => handlers.set(name, handler), logger: { log: () => undefined } } as unknown as PluginAPI;
      createLoreOrbPlugin({
        loreApiOrigin: 'https://lore.test', expectedAmpWorkspaceId: 'workspace',
        fetch: async () => { requests += 1; return new Response('{}'); },
      })(amp);
      await handlers.get('agent.end')?.({
        thread: { id: 'T-workspace' },
        status: 'done',
        messages: [],
      }, {
        thread: pluginThread('T-workspace'),
        $: async () => ({ exitCode: 0, stdout: token, stderr: '' }),
      });
      expect(requests).toBe(expectedRequests);
    }
  });

  test('checked-in Orb bundle is self-contained and contains no injected deployment values', () => {
    const bundle = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'lore-orb-bundled.js'), 'utf8');
    expect(bundle).toContain('createLoreOrbPlugin');
    expect(bundle).toContain('readMessages.call(thread');
    expect(bundle).toContain('work.event.status !== "done"');
    expect(bundle).not.toContain('amp threads export');
    expect(bundle).not.toMatch(/from ["'][.]{2}\//);
    for (const forbidden of ['@lore/', 'challenge-secret', 'workspace-1', 'LORE_PLUGIN_STATE_DIR', 'getValidAccessToken']) {
      expect(bundle).not.toContain(forbidden);
    }
  });
});
