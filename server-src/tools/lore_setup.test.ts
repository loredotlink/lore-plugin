import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLoreSetup, loreSetupTool } from './lore_setup';
import { writePluginState } from '../lib/pluginState';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-setup-test-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function resourceBlocks(result: { content: unknown[] }): unknown[] {
  return (result.content as Array<{ type: string }>).filter(
    (b) => b.type === 'resource',
  );
}

function textOf(result: { content: unknown[] }): string {
  return (result.content as Array<{ type: string }>)
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: string; text: string }).text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let home: string;

beforeEach(() => {
  home = makeTmpHome();
});

afterEach(() => {
  rmrf(home);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runLoreSetup — consent surface (unconsented / declined)', () => {
  test('consent=unconsented → buildConsentSurface shape: text + structuredContent, no resource block', async () => {
    // default state is unconsented; no file needed
    const result = await runLoreSetup({}, { home });
    expect(resourceBlocks(result)).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({ consent: 'unconsented' });
    expect(textOf(result)).toContain('lore_consent');
  });

  test('consent=unconsented → result carries no _meta', async () => {
    const result = await runLoreSetup({}, { home });
    expect('_meta' in result).toBe(false);
  });

  test('consent=declined → buildConsentSurface shape: text + structuredContent, no resource block', async () => {
    await writePluginState(
      { share_count: 0, watcher_prompt_dismissed: false, consent: 'declined' },
      home,
    );
    const result = await runLoreSetup({}, { home });
    expect(resourceBlocks(result)).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({ consent: 'declined' });
    expect(textOf(result)).toBeTruthy();
  });
});

describe('runLoreSetup — status result (consented / installed / idle / capturing)', () => {
  test('consent=consented → status result with NO resource block', async () => {
    await writePluginState(
      { share_count: 0, watcher_prompt_dismissed: false, consent: 'consented' },
      home,
    );
    const result = await runLoreSetup({}, { home });
    expect(resourceBlocks(result)).toHaveLength(0);
  });

  test('consent=consented → text mentions the disable affordance', async () => {
    await writePluginState(
      { share_count: 0, watcher_prompt_dismissed: false, consent: 'consented' },
      home,
    );
    const result = await runLoreSetup({}, { home });
    const text = textOf(result);
    expect(text.toLowerCase()).toMatch(/consent/);
    expect(text).toContain('approve: false');
  });

  test('consent=installed → status result with NO resource block', async () => {
    await writePluginState(
      { share_count: 0, watcher_prompt_dismissed: false, consent: 'installed' },
      home,
    );
    const result = await runLoreSetup({}, { home });
    expect(resourceBlocks(result)).toHaveLength(0);
  });

  test('consent=idle → status result with NO resource block', async () => {
    await writePluginState(
      { share_count: 0, watcher_prompt_dismissed: false, consent: 'idle' },
      home,
    );
    const result = await runLoreSetup({}, { home });
    expect(resourceBlocks(result)).toHaveLength(0);
  });

  test('consent=capturing → status result with NO resource block', async () => {
    await writePluginState(
      { share_count: 0, watcher_prompt_dismissed: false, consent: 'capturing' },
      home,
    );
    const result = await runLoreSetup({}, { home });
    expect(resourceBlocks(result)).toHaveLength(0);
  });

  test('consent=capturing → text mentions active/capturing', async () => {
    await writePluginState(
      { share_count: 0, watcher_prompt_dismissed: false, consent: 'capturing' },
      home,
    );
    const result = await runLoreSetup({}, { home });
    expect(textOf(result).toLowerCase()).toMatch(/active|captur/);
  });
});

describe('loreSetupTool definition', () => {
  test('tool name is "lore_setup"', () => {
    expect(loreSetupTool.name).toBe('lore_setup');
  });

  test('tool definition carries no _meta', () => {
    expect('_meta' in loreSetupTool).toBe(false);
  });

  test('inputSchema has type "object"', () => {
    expect(loreSetupTool.inputSchema.type).toBe('object');
  });

  test('inputSchema has no required fields', () => {
    const required = loreSetupTool.inputSchema.required;
    expect(!required || required.length === 0).toBe(true);
  });

  test('inputSchema has additionalProperties: false', () => {
    expect(loreSetupTool.inputSchema.additionalProperties).toBe(false);
  });

  test('handler returns a CallToolResult-shaped object (has content array)', async () => {
    const result = (await loreSetupTool.handler({})) as { content: unknown[] };
    expect(result).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
  });
});
