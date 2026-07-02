import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cloudBaseUrl,
  cloudMcpBaseUrl,
  __resetCloudBaseUrlForTests,
} from './cloudBaseUrl';

const ENV_KEY = 'LORE_MCP_BASE_URL';
const MCP_ENV_KEY = 'LORE_MCP_PROXY_BASE_URL';
const PROD_DEFAULT = 'https://mcp.lore.link';

describe('cloudBaseUrl', () => {
  let saved: string | undefined;
  let savedPluginStateDir: string | undefined;
  let tempDir: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV_KEY];
    savedPluginStateDir = process.env.LORE_PLUGIN_STATE_DIR;
    tempDir = undefined;
    delete process.env[ENV_KEY];
    delete process.env[MCP_ENV_KEY];
    delete process.env.LORE_PLUGIN_STATE_DIR;
    __resetCloudBaseUrlForTests();
  });

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (saved === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = saved;
    }
    if (savedPluginStateDir === undefined) {
      delete process.env.LORE_PLUGIN_STATE_DIR;
    } else {
      process.env.LORE_PLUGIN_STATE_DIR = savedPluginStateDir;
    }
    delete process.env[MCP_ENV_KEY];
    __resetCloudBaseUrlForTests();
  });

  test('returns the production default when the env var is unset', () => {
    expect(cloudBaseUrl()).toBe(PROD_DEFAULT);
  });

  test('returns the env override when set', () => {
    process.env[ENV_KEY] = 'http://localhost:4000';
    __resetCloudBaseUrlForTests();
    expect(cloudBaseUrl()).toBe('http://localhost:4000');
  });

  test('strips a single trailing slash', () => {
    process.env[ENV_KEY] = 'http://localhost:4000/';
    __resetCloudBaseUrlForTests();
    expect(cloudBaseUrl()).toBe('http://localhost:4000');
  });

  test('strips multiple trailing slashes', () => {
    process.env[ENV_KEY] = 'http://localhost:4000///';
    __resetCloudBaseUrlForTests();
    expect(cloudBaseUrl()).toBe('http://localhost:4000');
  });

  test('treats empty-string env as unset (returns prod default)', () => {
    process.env[ENV_KEY] = '';
    __resetCloudBaseUrlForTests();
    expect(cloudBaseUrl()).toBe(PROD_DEFAULT);
  });

  test('invalid URL in env throws at load time with a clear message naming the env var', () => {
    process.env[ENV_KEY] = 'not-a-url';
    expect(() => __resetCloudBaseUrlForTests()).toThrow(/LORE_MCP_BASE_URL/);
  });

  test('caches the resolved value at module load — env mutations after load do not affect it', () => {
    process.env[ENV_KEY] = 'http://localhost:4000';
    __resetCloudBaseUrlForTests();
    const first = cloudBaseUrl();
    // Mutate env, but do NOT call the reset helper.
    process.env[ENV_KEY] = 'http://localhost:9999';
    for (let i = 0; i < 1000; i++) {
      expect(cloudBaseUrl()).toBe(first);
    }
    expect(cloudBaseUrl()).toBe('http://localhost:4000');
  });

  test('__resetCloudBaseUrlForTests re-reads the env var', () => {
    process.env[ENV_KEY] = 'http://localhost:4000';
    __resetCloudBaseUrlForTests();
    expect(cloudBaseUrl()).toBe('http://localhost:4000');
    process.env[ENV_KEY] = 'http://localhost:5000';
    __resetCloudBaseUrlForTests();
    expect(cloudBaseUrl()).toBe('http://localhost:5000');
  });

  test('accepts https URLs with a port', () => {
    process.env[ENV_KEY] = 'https://staging.example.com:8443';
    __resetCloudBaseUrlForTests();
    expect(cloudBaseUrl()).toBe('https://staging.example.com:8443');
  });

  test('cloudMcpBaseUrl defaults to the auth/discovery base URL', () => {
    process.env[ENV_KEY] = 'https://staging.example.com';
    __resetCloudBaseUrlForTests();
    expect(cloudMcpBaseUrl()).toBe('https://staging.example.com');
  });

  test('cloudMcpBaseUrl can point proxy calls at localhost without changing auth discovery', () => {
    process.env[MCP_ENV_KEY] = 'http://localhost:4000';
    __resetCloudBaseUrlForTests();
    expect(cloudBaseUrl()).toBe(PROD_DEFAULT);
    expect(cloudMcpBaseUrl()).toBe('http://localhost:4000');
  });

  test('cloudMcpBaseUrl strips trailing slashes from its override', () => {
    process.env[MCP_ENV_KEY] = 'http://localhost:4000///';
    __resetCloudBaseUrlForTests();
    expect(cloudMcpBaseUrl()).toBe('http://localhost:4000');
  });

  test('cloudMcpBaseUrl uses installed plugin runtime config when env override is unset', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-plugin-config-test-'));
    process.env.LORE_PLUGIN_STATE_DIR = tempDir;
    const configFile = path.join(tempDir, 'harness', 'amp', 'lore-plugin', 'lore-plugin-config.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ mcpBaseUrl: 'http://localhost:4000///' }));

    __resetCloudBaseUrlForTests();
    expect(cloudBaseUrl()).toBe(PROD_DEFAULT);
    expect(cloudMcpBaseUrl()).toBe('http://localhost:4000');
  });

  test('explicit cloudMcpBaseUrl env override wins over installed plugin runtime config', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-plugin-config-test-'));
    process.env.LORE_PLUGIN_STATE_DIR = tempDir;
    process.env[MCP_ENV_KEY] = 'http://localhost:5000';
    const configFile = path.join(tempDir, 'harness', 'amp', 'lore-plugin', 'lore-plugin-config.json');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ mcpBaseUrl: 'http://localhost:4000' }));

    __resetCloudBaseUrlForTests();
    expect(cloudMcpBaseUrl()).toBe('http://localhost:5000');
  });
});
