import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PluginCommandContext } from '@ampcode/plugin';

import {
  configureLoreStateDirForInstalledAmpPlugin,
  inferLoreStateDirFromAmpPluginUrl,
  shareActiveThread,
} from './lore';

function makeContext(): PluginCommandContext & {
  appendedMessages: Array<{ type: 'user-message'; content: string }>;
  notifications: string[];
  inputs: Array<{ title?: string; helpText?: string; initialValue?: string; submitButtonText?: string }>;
  openedUrls: Array<string | URL>;
  shellCalls: Array<{ strings: readonly string[]; values: unknown[] }>;
  failClipboard: boolean;
  failOpen: boolean;
  failInput: boolean;
} {
  const appendedMessages: Array<{ type: 'user-message'; content: string }> = [];
  const notifications: string[] = [];
  const inputs: Array<{ title?: string; helpText?: string; initialValue?: string; submitButtonText?: string }> = [];
  const openedUrls: Array<string | URL> = [];
  const shellCalls: Array<{ strings: readonly string[]; values: unknown[] }> = [];

  const ctx = {
    appendedMessages,
    notifications,
    inputs,
    openedUrls,
    shellCalls,
    thread: {
      id: 'T-amp-thread',
      append: async (messages) => {
        appendedMessages.push(...messages);
      },
    },
    ui: {
      notify: async (message) => {
        notifications.push(message);
      },
      input: async (options) => {
        if (ctx.failInput) throw new Error('input unavailable');
        inputs.push(options);
        return undefined;
      },
    },
    system: {
      ampURL: new URL('https://ampcode.com/'),
      open: async (url) => {
        if (ctx.failOpen) throw new Error('open unavailable');
        openedUrls.push(url);
      },
    },
    $: async (strings, ...values) => {
      shellCalls.push({ strings: [...strings], values });
      if (ctx.failClipboard) return { exitCode: 1, stdout: '', stderr: 'pbcopy unavailable' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    failClipboard: false,
    failOpen: false,
    failInput: false,
  } as PluginCommandContext & {
    appendedMessages: Array<{ type: 'user-message'; content: string }>;
    notifications: string[];
    inputs: Array<{ title?: string; helpText?: string; initialValue?: string; submitButtonText?: string }>;
    openedUrls: Array<string | URL>;
    shellCalls: Array<{ strings: readonly string[]; values: unknown[] }>;
    failClipboard: boolean;
    failOpen: boolean;
    failInput: boolean;
  };

  return ctx;
}

describe('installed Amp plugin state dir inference', () => {
  test('infers the owning Lore state dir from the materialized harness plugin path', () => {
    const stateDir = path.join('/tmp', 'home', '.lore-dev-stack');
    const pluginFile = path.join(stateDir, 'harness', 'amp', 'lore-plugin', 'amp', 'lore.ts');

    expect(inferLoreStateDirFromAmpPluginUrl(pathToFileURL(pluginFile).href)).toBe(stateDir);
  });

  test('infers the owning Lore state dir from the bundled materialized harness plugin path', () => {
    const stateDir = path.join('/tmp', 'home', '.lore-dev-stack');
    const pluginFile = path.join(stateDir, 'harness', 'amp', 'lore-plugin', 'amp', 'lore-bundled.js');

    expect(inferLoreStateDirFromAmpPluginUrl(pathToFileURL(pluginFile).href)).toBe(stateDir);
  });

  test('infers through Amp plugin symlinks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-amp-plugin-test-'));
    try {
      const stateDir = path.join(root, '.lore-dev-stack');
      const pluginFile = path.join(stateDir, 'harness', 'amp', 'lore-plugin', 'amp', 'lore.ts');
      const symlinkFile = path.join(root, '.config', 'amp', 'plugins', 'lore.ts');
      fs.mkdirSync(path.dirname(pluginFile), { recursive: true });
      fs.mkdirSync(path.dirname(symlinkFile), { recursive: true });
      fs.writeFileSync(pluginFile, 'export default function plugin() {}\n');
      fs.symlinkSync(pluginFile, symlinkFile);

      expect(inferLoreStateDirFromAmpPluginUrl(pathToFileURL(symlinkFile).href)).toBe(fs.realpathSync(stateDir));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns null for source-tree plugin paths', () => {
    const sourceFile = path.join('/repo', 'packages', 'lore-plugin', 'amp', 'lore.ts');

    expect(inferLoreStateDirFromAmpPluginUrl(pathToFileURL(sourceFile).href)).toBeNull();
  });
});

describe('configureLoreStateDirForInstalledAmpPlugin — test-suite isolation (TAN-5045)', () => {
  // The plugin test suite imports this module into ONE shared bun-test
  // process. If the module's top-level inference ran here it would set
  // LORE_PLUGIN_STATE_DIR process-wide, and — because that env var is an
  // absolute override that wins over the explicit `home` arg — redirect every
  // OTHER test's token writes into the developer's real ~/.lore. The test
  // preload sets LORE_PLUGIN_TEST_SANDBOX=1 so inference is a no-op.
  function withEnv(fn: () => void): void {
    const savedFlag = process.env.LORE_PLUGIN_TEST_SANDBOX;
    const savedStateDir = process.env.LORE_PLUGIN_STATE_DIR;
    try {
      fn();
    } finally {
      if (savedFlag === undefined) delete process.env.LORE_PLUGIN_TEST_SANDBOX;
      else process.env.LORE_PLUGIN_TEST_SANDBOX = savedFlag;
      if (savedStateDir === undefined) delete process.env.LORE_PLUGIN_STATE_DIR;
      else process.env.LORE_PLUGIN_STATE_DIR = savedStateDir;
    }
  }

  const installedPluginUrl = pathToFileURL(
    path.join('/tmp', 'home', '.lore-dev-stack', 'harness', 'amp', 'lore-plugin', 'amp', 'lore.ts'),
  ).href;

  test('does NOT mutate LORE_PLUGIN_STATE_DIR when the sandbox flag is set', () => {
    withEnv(() => {
      process.env.LORE_PLUGIN_TEST_SANDBOX = '1';
      delete process.env.LORE_PLUGIN_STATE_DIR;

      configureLoreStateDirForInstalledAmpPlugin(installedPluginUrl);

      expect(process.env.LORE_PLUGIN_STATE_DIR).toBeUndefined();
    });
  });

  test('infers and sets LORE_PLUGIN_STATE_DIR when the sandbox flag is absent', () => {
    withEnv(() => {
      delete process.env.LORE_PLUGIN_TEST_SANDBOX;
      delete process.env.LORE_PLUGIN_STATE_DIR;

      configureLoreStateDirForInstalledAmpPlugin(installedPluginUrl);

      // Snapshot the env: TS narrows `process.env.X` to `undefined` after the
      // `delete` above and can't see the opaque call reassign it. A fresh
      // object breaks that flow-narrowing.
      const env = { ...process.env };
      expect(env.LORE_PLUGIN_STATE_DIR).toBe(path.join('/tmp', 'home', '.lore-dev-stack'));
    });
  });
});

describe('bundled Amp plugin artifact', () => {
  test('is checked in without runtime imports of workspace packages', () => {
    const bundlePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lore-bundled.js');
    const bundle = fs.readFileSync(bundlePath, 'utf8');

    expect(bundle).toContain('export {');
    expect(bundle).not.toContain('@lore/identity-store');
    expect(bundle).not.toContain('@lore/contracts');
    expect(bundle).not.toContain('@lore/transcript-locate');
  });
});

describe('Lore Amp command', () => {
  test('writes the Lore thread URL into the active Amp thread after sharing', async () => {
    const ctx = makeContext();

    await shareActiveThread(ctx, {
      env: {},
      runAmpExport: async () => JSON.stringify({ title: 'Shared Amp Thread', messages: [] }),
      share: async () => ({ thread_url: 'https://lore.test/threads/thread-1' }),
    });

    expect(ctx.appendedMessages).toEqual([
      {
        type: 'user-message',
        content: 'Shared this Amp thread to Lore: https://lore.test/threads/thread-1',
      },
    ]);
    expect(ctx.notifications).toEqual(['Shared Amp thread to Lore: https://lore.test/threads/thread-1. Copied Lore URL to clipboard.']);
    expect(ctx.inputs).toEqual([]);
    expect(ctx.openedUrls).toEqual([]);
  });

  test('copies the Lore thread URL to the local clipboard after sharing', async () => {
    const ctx = makeContext();

    await shareActiveThread(ctx, {
      env: {},
      runAmpExport: async () => JSON.stringify({ title: 'Shared Amp Thread', messages: [] }),
      share: async () => ({ thread_url: 'https://lore.test/threads/thread-copied' }),
    });

    expect(ctx.shellCalls).toEqual([
      {
        strings: ['sh -c ', ' sh ', ''],
        values: ['printf %s "$1" | pbcopy', 'https://lore.test/threads/thread-copied'],
      },
    ]);
    expect(ctx.notifications).toEqual([
      'Shared Amp thread to Lore: https://lore.test/threads/thread-copied. Copied Lore URL to clipboard.',
    ]);
  });

  test('extracts the Lore thread URL from MCP text content returned by the share tool', async () => {
    const ctx = makeContext();

    await shareActiveThread(ctx, {
      env: {},
      runAmpExport: async () => JSON.stringify({ title: 'Shared Amp Thread', messages: [] }),
      share: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              thread_id: 'thread-mcp',
              thread_url: 'https://lore.test/threads/thread-mcp',
            }),
          },
        ],
      }),
    });

    expect(ctx.appendedMessages).toEqual([
      {
        type: 'user-message',
        content: 'Shared this Amp thread to Lore: https://lore.test/threads/thread-mcp',
      },
    ]);
    expect(ctx.shellCalls).toEqual([
      {
        strings: ['sh -c ', ' sh ', ''],
        values: ['printf %s "$1" | pbcopy', 'https://lore.test/threads/thread-mcp'],
      },
    ]);
    expect(ctx.inputs).toEqual([]);
    expect(ctx.openedUrls).toEqual([]);
    expect(ctx.notifications).toEqual([
      'Shared Amp thread to Lore: https://lore.test/threads/thread-mcp. Copied Lore URL to clipboard.',
    ]);
  });

  test('shows a copyable URL dialog when Amp does not expose a writable active thread', async () => {
    const ctx = makeContext();
    ctx.thread = undefined;

    await shareActiveThread(ctx, {
      env: { AMP_CURRENT_THREAD_ID: 'T-amp-thread' },
      runAmpExport: async () => JSON.stringify({ title: 'Shared Amp Thread', messages: [] }),
      share: async () => ({ thread_url: 'https://lore.test/threads/thread-2' }),
    });

    expect(ctx.appendedMessages).toEqual([]);
    expect(ctx.notifications).toEqual([
      'Shared Amp thread to Lore: https://lore.test/threads/thread-2. Amp did not expose an active thread to write into. Copied Lore URL to clipboard.',
    ]);
    expect(ctx.inputs).toEqual([
      {
        title: 'Shared Amp thread to Lore',
        helpText: 'Copy the Lore URL below.',
        initialValue: 'https://lore.test/threads/thread-2',
        submitButtonText: 'Done',
      },
    ]);
    expect(ctx.openedUrls).toEqual([]);
  });

  test('keeps sharing successful when appending the URL to Amp fails', async () => {
    const ctx = makeContext();
    ctx.thread = {
      id: 'T-amp-thread',
      append: async () => {
        throw new Error('append unavailable');
      },
    };

    await shareActiveThread(ctx, {
      env: {},
      runAmpExport: async () => JSON.stringify({ title: 'Shared Amp Thread', messages: [] }),
      share: async () => ({ thread_url: 'https://lore.test/threads/thread-3' }),
    });

    expect(ctx.appendedMessages).toEqual([]);
    expect(ctx.notifications).toEqual([
      'Shared Amp thread to Lore: https://lore.test/threads/thread-3. Amp could not write the URL into this thread: append unavailable. Copied Lore URL to clipboard.',
    ]);
    expect(ctx.inputs).toEqual([
      {
        title: 'Shared Amp thread to Lore',
        helpText: 'Copy the Lore URL below.',
        initialValue: 'https://lore.test/threads/thread-3',
        submitButtonText: 'Done',
      },
    ]);
    expect(ctx.openedUrls).toEqual([]);
  });

  test('keeps the Lore thread URL in the notification when clipboard and input fallbacks fail', async () => {
    const ctx = makeContext();
    ctx.failClipboard = true;
    ctx.failInput = true;

    await shareActiveThread(ctx, {
      env: {},
      runAmpExport: async () => JSON.stringify({ title: 'Shared Amp Thread', messages: [] }),
      share: async () => ({ thread_url: 'https://lore.test/threads/thread-visible' }),
    });

    expect(ctx.appendedMessages).toEqual([
      {
        type: 'user-message',
        content: 'Shared this Amp thread to Lore: https://lore.test/threads/thread-visible',
      },
    ]);
    expect(ctx.openedUrls).toEqual([]);
    expect(ctx.inputs).toEqual([]);
    expect(ctx.notifications).toEqual([
      'Shared Amp thread to Lore: https://lore.test/threads/thread-visible. Could not copy Lore URL to clipboard. Could not show copyable Lore URL dialog: input unavailable.',
    ]);
  });
});
