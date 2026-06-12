/**
 * Tests for the `lore_configure` tool. The CLI allowlist read/write are
 * injected, so no real `lore` binary is shelled and plugin state is
 * isolated in a tmp home.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runLoreConfigure, loreConfigureTool } from './lore_configure.js';
import {
  readPluginState,
  writePluginState,
  type ConsentState,
} from '../lib/pluginState.js';
import type {
  AllowlistDocument,
  AllowlistResult,
} from '../lib/uploadAllowlist.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-configure-test-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function textOf(result: { content: unknown[] }): string {
  return (result.content as Array<{ type: string }>)
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: string; text: string }).text)
    .join('\n');
}

function resourceBlocks(result: { content: unknown[] }): unknown[] {
  return (result.content as Array<{ type: string }>).filter(
    (b) => b.type === 'resource',
  );
}

function doc(
  include: Partial<AllowlistDocument['uploadFilters']['include']> = {},
  exclude: Partial<AllowlistDocument['uploadFilters']['exclude']> = {},
): AllowlistDocument {
  return {
    version: 1,
    uploadFilters: {
      include: { cwd: [], repo: [], skills: [], ...include },
      exclude: { cwd: [], repo: [], skills: [], ...exclude },
    },
  };
}

async function setConsent(consent: ConsentState): Promise<void> {
  await writePluginState(
    { share_count: 0, watcher_prompt_dismissed: false, consent },
    home,
  );
}

describe('runLoreConfigure — not yet installed', () => {
  for (const consent of ['consented', 'declined'] as const) {
    test(`consent=${consent} → points at /lore:setup, does not touch the CLI`, async () => {
      await setConsent(consent);
      const result = await runLoreConfigure(
        { repos: ['owner/repo'] },
        {
          home,
          readAllowlist: async () => {
            throw new Error('should not read allowlist before install');
          },
          writeAllowlist: async () => {
            throw new Error('should not write allowlist before install');
          },
        },
      );
      expect(textOf(result)).toContain('/lore:setup');
      expect((await readPluginState(home)).consent).toBe(consent);
    });
  }
});

describe('runLoreConfigure — write success', () => {
  test('merges new repos into the existing allowlist and transitions idle → capturing', async () => {
    await setConsent('idle');
    const existing = doc({ repo: ['owner/existing'] });
    let written: AllowlistDocument | undefined;
    const result = await runLoreConfigure(
      { repos: ['owner/new'] },
      {
        home,
        readAllowlist: async () => ({ ok: true, document: existing }),
        writeAllowlist: async (document) => {
          written = document;
          return { ok: true, document };
        },
      },
    );

    expect(written?.uploadFilters.include.repo).toEqual([
      'owner/existing',
      'owner/new',
    ]);
    expect((await readPluginState(home)).consent).toBe('capturing');
    expect(resourceBlocks(result)).toHaveLength(0);
    expect(textOf(result).toLowerCase()).toMatch(/watching|capture/);
    expect(result.structuredContent).toMatchObject({ consent: 'capturing' });
  });

  test('replace mode overwrites the include sets and preserves exclude', async () => {
    await setConsent('capturing');
    const existing = doc({ repo: ['owner/old'] }, { repo: ['owner/blocked'] });
    let written: AllowlistDocument | undefined;
    await runLoreConfigure(
      { directories: ['~/code/project'], mode: 'replace' },
      {
        home,
        readAllowlist: async () => ({ ok: true, document: existing }),
        writeAllowlist: async (document) => {
          written = document;
          return { ok: true, document };
        },
      },
    );

    expect(written?.uploadFilters.include.repo).toEqual([]);
    expect(written?.uploadFilters.include.cwd).toEqual(['~/code/project']);
    // exclude is carried through untouched.
    expect(written?.uploadFilters.exclude.repo).toEqual(['owner/blocked']);
  });

  test('replace with all-empty lists clears the allowlist and transitions to idle', async () => {
    await setConsent('capturing');
    const existing = doc({ repo: ['owner/old'] });
    const result = await runLoreConfigure(
      { mode: 'replace' },
      {
        home,
        readAllowlist: async () => ({ ok: true, document: existing }),
        writeAllowlist: async (document) => ({ ok: true, document }),
      },
    );
    expect((await readPluginState(home)).consent).toBe('idle');
    expect(textOf(result).toLowerCase()).toMatch(/idle|nothing/);
    expect(result.structuredContent).toMatchObject({ consent: 'idle' });
  });

  test('reflects the CLI-normalized document, not the raw input', async () => {
    await setConsent('installed');
    let result = await runLoreConfigure(
      { repos: ['Owner/Repo'], mode: 'replace' },
      {
        home,
        readAllowlist: async () => ({ ok: true, document: doc() }),
        // Simulate the CLI lowercasing the repo on write.
        writeAllowlist: async () => ({
          ok: true,
          document: doc({ repo: ['owner/repo'] }),
        }),
      },
    );
    expect(textOf(result)).toContain('owner/repo');
    expect(textOf(result)).not.toContain('Owner/Repo');
  });
});

describe('runLoreConfigure — failures', () => {
  test('read failure surfaces the CLI error and leaves state unchanged', async () => {
    await setConsent('idle');
    const result = await runLoreConfigure(
      { repos: ['owner/repo'] },
      {
        home,
        readAllowlist: async (): Promise<AllowlistResult> => ({
          ok: false,
          message: 'not logged in',
        }),
        writeAllowlist: async () => {
          throw new Error('should not write after a read failure');
        },
      },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not logged in');
    expect((await readPluginState(home)).consent).toBe('idle');
  });

  test('a missing-CLI error points back at /lore:setup', async () => {
    await setConsent('idle');
    const result = await runLoreConfigure(
      { repos: ['owner/repo'] },
      {
        home,
        readAllowlist: async (): Promise<AllowlistResult> => ({
          ok: false,
          message: 'spawn lore ENOENT',
        }),
        writeAllowlist: async () => ({ ok: true, document: doc() }),
      },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('/lore:setup');
  });

  test('rejects a non-string-array input', async () => {
    await setConsent('idle');
    const result = await runLoreConfigure(
      { repos: [123] as unknown as string[] },
      {
        home,
        readAllowlist: async () => {
          throw new Error('should not read with invalid input');
        },
        writeAllowlist: async () => ({ ok: true, document: doc() }),
      },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/array of strings/);
  });

  test('rejects an invalid mode', async () => {
    await setConsent('idle');
    const result = await runLoreConfigure(
      { mode: 'wipe' as unknown as 'merge' },
      {
        home,
        readAllowlist: async () => {
          throw new Error('should not read with invalid mode');
        },
        writeAllowlist: async () => ({ ok: true, document: doc() }),
      },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/merge.*replace|replace.*merge/);
  });
});

describe('loreConfigureTool definition', () => {
  test('tool name is "lore_configure"', () => {
    expect(loreConfigureTool.name).toBe('lore_configure');
  });

  test('inputSchema has type object and additionalProperties false', () => {
    expect(loreConfigureTool.inputSchema.type).toBe('object');
    expect(loreConfigureTool.inputSchema.additionalProperties).toBe(false);
  });

  test('inputSchema requires no fields', () => {
    const required = loreConfigureTool.inputSchema.required;
    expect(!required || required.length === 0).toBe(true);
  });

  test('carries no _meta', () => {
    expect('_meta' in loreConfigureTool).toBe(false);
  });
});
