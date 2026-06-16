import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Tokens, deleteTokens, readTokens, tokensFilePath, writeTokens } from './store';

// The token format, atomic-write semantics, schema, and 0600/0700 permissions
// are owned and unit-tested by `@lore/identity-store`. This suite covers the
// plugin-side adapter: the canonical `~/.lore` path and legacy migration.

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-tokens-test-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function legacyPluginTokensFile(home: string): string {
  return path.join(home, 'Library', 'Application Support', 'tanagram', 'lore', 'tokens.json');
}

const validTokens: Tokens = {
  access_token: 'access-AAA',
  refresh_token: 'refresh-BBB',
  expires_at: 1_700_000_000_000,
  scope: 'read:sessions write:sessions',
};

describe('tokensFilePath', () => {
  test('points at the canonical ~/.lore tokens file', () => {
    expect(tokensFilePath('/Users/test')).toBe('/Users/test/.lore/tokens.json');
  });

  test('defaults to os.homedir() when no override is passed', () => {
    expect(tokensFilePath()).toBe(path.join(os.homedir(), '.lore', 'tokens.json'));
  });
});

describe('read/write/delete (adapter over the canonical store)', () => {
  let home: string;
  beforeEach(() => {
    home = makeTmpHome();
  });
  afterEach(() => {
    rmrf(home);
  });

  test('returns null when the tokens file is absent', async () => {
    expect(await readTokens(home)).toBeNull();
  });

  test('round-trips a token record', async () => {
    await writeTokens(validTokens, home);
    expect(await readTokens(home)).toEqual(validTokens);
  });

  test('deleteTokens removes the file and is idempotent', async () => {
    await writeTokens(validTokens, home);
    expect(fs.existsSync(tokensFilePath(home))).toBe(true);
    await deleteTokens(home);
    expect(fs.existsSync(tokensFilePath(home))).toBe(false);
    await expect(deleteTokens(home)).resolves.toBeUndefined();
  });

  test('deleteTokens also clears the legacy CLI token files in ~/.lore', async () => {
    // The CLI's pre-consolidation files live in the same shared dir; if logout
    // left them behind the CLI would re-migrate them and resurrect the session.
    const stateDir = path.join(home, '.lore');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'token'), 'legacy-access', 'utf8');
    fs.writeFileSync(path.join(stateDir, 'refresh_token'), 'legacy-refresh', 'utf8');
    await writeTokens(validTokens, home);

    await deleteTokens(home);

    expect(fs.existsSync(path.join(stateDir, 'token'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'refresh_token'))).toBe(false);
  });

  test('degrades to null (does not throw) when the canonical file is corrupt', async () => {
    const file = tokensFilePath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json at all {', 'utf8');
    expect(await readTokens(home)).toBeNull();
  });

  test('recovers legacy plugin credentials when the canonical file is corrupt', async () => {
    const file = tokensFilePath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json at all {', 'utf8');
    const legacy = legacyPluginTokensFile(home);
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify(validTokens), 'utf8');

    expect(await readTokens(home)).toEqual(validTokens);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  test('does NOT adopt the legacy CLI two-file layout (separate identities, TAN-4329)', async () => {
    // Pre-consolidation the plugin and CLI shared one identity, so the plugin
    // migrated the CLI's two-file layout too. Under TAN-4329 they authenticate
    // separately: that layout holds the CLI's WorkOS User Management token,
    // which must not become the plugin's AuthKit token. The plugin stays
    // logged out; the CLI owns and re-authenticates its own slot.
    const stateDir = path.join(home, '.lore');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'token'), 'cli-access', 'utf8');
    fs.writeFileSync(path.join(stateDir, 'refresh_token'), 'cli-refresh', 'utf8');

    expect(await readTokens(home)).toBeNull();
  });

  test('writeTokens clears leftover legacy CLI files (canonical is source of truth)', async () => {
    const stateDir = path.join(home, '.lore');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'token'), 'stale-access', 'utf8');
    fs.writeFileSync(path.join(stateDir, 'refresh_token'), 'stale-refresh', 'utf8');

    await writeTokens(validTokens, home);

    expect(fs.existsSync(path.join(stateDir, 'token'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'refresh_token'))).toBe(false);
  });
});

describe('legacy Application Support migration', () => {
  let home: string;
  beforeEach(() => {
    home = makeTmpHome();
  });
  afterEach(() => {
    rmrf(home);
  });

  test('migrates the legacy tokens file into ~/.lore on first read, then removes it', async () => {
    const legacy = legacyPluginTokensFile(home);
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify(validTokens), 'utf8');

    // No canonical file yet — the read should migrate from the legacy location.
    expect(fs.existsSync(tokensFilePath(home))).toBe(false);
    expect(await readTokens(home)).toEqual(validTokens);

    // Canonical file now exists; the legacy file is gone.
    expect(fs.existsSync(tokensFilePath(home))).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  test('prefers an existing canonical file over the legacy one', async () => {
    const canonical: Tokens = { ...validTokens, access_token: 'CANONICAL' };
    await writeTokens(canonical, home);

    const legacy = legacyPluginTokensFile(home);
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, JSON.stringify({ ...validTokens, access_token: 'LEGACY' }), 'utf8');

    expect((await readTokens(home))?.access_token).toBe('CANONICAL');
  });
});
