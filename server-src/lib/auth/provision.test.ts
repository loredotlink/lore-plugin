import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readApiKey } from '@lore/identity-store';
import { stateDir, writeTokens } from './store';
import { __resetCloudBaseUrlForTests } from '../cloudBaseUrl';
import {
  createUploadApiKey,
  pluginApiKeyName,
  provisionSharedApiKey,
} from './provision';

let home: string;
const originalEnvKey = process.env.LORE_API_KEY;
const originalBaseUrl = process.env.LORE_MCP_BASE_URL;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-plugin-provision-'));
  delete process.env.LORE_API_KEY;
  process.env.LORE_MCP_BASE_URL = 'http://localhost:4000';
  __resetCloudBaseUrlForTests();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (originalEnvKey === undefined) delete process.env.LORE_API_KEY;
  else process.env.LORE_API_KEY = originalEnvKey;
  if (originalBaseUrl === undefined) delete process.env.LORE_MCP_BASE_URL;
  else process.env.LORE_MCP_BASE_URL = originalBaseUrl;
  __resetCloudBaseUrlForTests();
});

describe('pluginApiKeyName', () => {
  test('stamps the hostname for revocation legibility', () => {
    expect(pluginApiKeyName('mbp.local')).toBe('plugin@mbp.local');
  });
});

describe('provisionSharedApiKey', () => {
  test('mints via the REST endpoint owner and persists to the shared apiKey slot', async () => {
    let calledWithName: string | undefined;
    const result = await provisionSharedApiKey({
      home,
      hostname: 'testhost',
      now: () => 1_720_000_000_000,
      createUploadApiKeyImpl: async (name) => {
        calledWithName = name;
        return 'lore_uak_minted';
      },
    });

    expect(result).toEqual({ provisioned: true });
    expect(calledWithName).toBe('plugin@testhost');
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
      createUploadApiKeyImpl: async () => 'lore_uak_first',
    });

    let secondCallMade = false;
    const result = await provisionSharedApiKey({
      home,
      createUploadApiKeyImpl: async () => {
        secondCallMade = true;
        return 'lore_uak_second';
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
      createUploadApiKeyImpl: async () => {
        called = true;
        return 'lore_uak_should_not_mint';
      },
    });
    expect(result).toEqual({ provisioned: false });
    expect(called).toBe(false);
    expect(await readApiKey(stateDir(home))).toBeNull();
  });

  test('is non-fatal — stores nothing when the endpoint result has no raw_key', async () => {
    const result = await provisionSharedApiKey({
      home,
      createUploadApiKeyImpl: async () => null,
    });
    expect(result).toEqual({ provisioned: false });
    expect(await readApiKey(stateDir(home))).toBeNull();
  });
});

describe('createUploadApiKey', () => {
  test('posts the OAuth credential to the REST endpoint and validates the response', async () => {
    await writeTokens({
      access_token: 'oauth-access-token',
      refresh_token: 'oauth-refresh-token',
      expires_at: Date.now() + 60_000,
      scope: 'openid email profile offline_access',
    }, home);
    let requestedUrl: string | undefined;
    let requestedAuthorization: string | undefined;
    let requestedName: string | undefined;
    const rawKey = await createUploadApiKey('plugin@testhost', {
      home,
      fetchImpl: (async (url, init) => {
        requestedUrl = String(url);
        requestedAuthorization = new Headers(init?.headers).get('authorization') ?? undefined;
        requestedName = JSON.parse(String(init?.body)).name;
        return Response.json({
          id: 'uak_test',
          name: 'plugin@testhost',
          organization_id: 'org_test',
          key_prefix: 'lore_uak_tes',
          key_last_four: 'test',
          default_visibility: 'workspace',
          created_at: new Date(0).toISOString(),
          last_used_at: null,
          revoked_at: null,
          raw_key: 'lore_uak_minted',
        }, { status: 201 });
      }) as typeof fetch,
    });

    expect(requestedUrl).toBe('http://localhost:4000/api/upload_api_keys');
    expect(requestedAuthorization).toBe('Bearer oauth-access-token');
    expect(requestedName).toBe('plugin@testhost');
    expect(rawKey).toBe('lore_uak_minted');
  });

  test('does not copy an upstream response body into errors', async () => {
    await writeTokens({
      access_token: 'oauth-access-token',
      refresh_token: 'oauth-refresh-token',
      expires_at: Date.now() + 60_000,
      scope: 'openid email profile offline_access',
    }, home);

    const failingFetch = Object.assign(
      async () => new Response(
        'upstream echoed lore_uak_sensitive-response-value',
        { status: 500 },
      ),
      { preconnect: fetch.preconnect },
    );
    let error: Error | undefined;
    try {
      await createUploadApiKey('plugin@testhost', {
        home,
        fetchImpl: failingFetch,
      });
    } catch (cause) {
      if (cause instanceof Error) error = cause;
    }

    expect(error?.message).toBe('Upload API key creation failed: HTTP 500');
    expect(error?.message).not.toContain('lore_uak_sensitive');
  });
});
