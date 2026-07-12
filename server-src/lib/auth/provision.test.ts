import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readApiKey } from '@lore/identity-store';
import { stateDir } from './store';
import {
  extractRawKey,
  pluginApiKeyName,
  provisionSharedApiKey,
} from './provision';

let home: string;
const originalEnvKey = process.env.LORE_API_KEY;

/** Shape the cloud MCP server wraps a plain-object tool return in. */
const cloudResult = (rawKey: string) => ({
  content: [{ type: 'text', text: JSON.stringify({ id: 'uak_1', raw_key: rawKey }) }],
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-plugin-provision-'));
  delete process.env.LORE_API_KEY;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (originalEnvKey === undefined) delete process.env.LORE_API_KEY;
  else process.env.LORE_API_KEY = originalEnvKey;
});

describe('extractRawKey', () => {
  test('reads raw_key from the wrapped text content', () => {
    expect(extractRawKey(cloudResult('lore_uak_abc'))).toBe('lore_uak_abc');
  });

  test('returns null for a non-content shape, bad JSON, or missing raw_key', () => {
    expect(extractRawKey(null)).toBeNull();
    expect(extractRawKey({ content: [{ type: 'text', text: 'not json' }] })).toBeNull();
    expect(extractRawKey({ content: [{ type: 'text', text: '{"id":"uak_1"}' }] })).toBeNull();
  });
});

describe('pluginApiKeyName', () => {
  test('stamps the hostname for revocation legibility', () => {
    expect(pluginApiKeyName('mbp.local')).toBe('plugin@mbp.local');
  });
});

describe('provisionSharedApiKey', () => {
  test('mints via the cloud tool and persists to the shared apiKey slot when none exists', async () => {
    let calledWith: { toolName: string; args: Record<string, unknown> } | undefined;
    const result = await provisionSharedApiKey({
      home,
      hostname: 'testhost',
      now: () => 1_720_000_000_000,
      callCloudToolImpl: async (toolName, args) => {
        calledWith = { toolName, args };
        return cloudResult('lore_uak_minted');
      },
    });

    expect(result).toEqual({ provisioned: true });
    expect(calledWith?.toolName).toBe('create_api_key');
    expect(calledWith?.args).toEqual({ name: 'plugin@testhost' });
    expect(await readApiKey(stateDir(home))).toEqual({
      value: 'lore_uak_minted',
      created_at: 1_720_000_000_000,
    });
  });

  test('is idempotent — skips the cloud call when a key is already stored', async () => {
    // Seed a stored key.
    await provisionSharedApiKey({
      home,
      now: () => 1,
      callCloudToolImpl: async () => cloudResult('lore_uak_first'),
    });

    let secondCallMade = false;
    const result = await provisionSharedApiKey({
      home,
      callCloudToolImpl: async () => {
        secondCallMade = true;
        return cloudResult('lore_uak_second');
      },
    });

    expect(result).toEqual({ provisioned: false });
    expect(secondCallMade).toBe(false);
    // The original key is untouched.
    expect((await readApiKey(stateDir(home)))?.value).toBe('lore_uak_first');
  });

  test('is idempotent — skips when LORE_API_KEY env override is set', async () => {
    process.env.LORE_API_KEY = 'lore_uak_env';
    let called = false;
    const result = await provisionSharedApiKey({
      home,
      callCloudToolImpl: async () => {
        called = true;
        return cloudResult('lore_uak_should_not_mint');
      },
    });
    expect(result).toEqual({ provisioned: false });
    expect(called).toBe(false);
    expect(await readApiKey(stateDir(home))).toBeNull();
  });

  test('is non-fatal — stores nothing when the cloud result has no raw_key', async () => {
    const result = await provisionSharedApiKey({
      home,
      callCloudToolImpl: async () => ({ content: [{ type: 'text', text: '{}' }] }),
    });
    expect(result).toEqual({ provisioned: false });
    expect(await readApiKey(stateDir(home))).toBeNull();
  });
});
