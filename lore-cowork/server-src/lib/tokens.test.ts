import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  TokensSchema,
  tokensFilePath,
  readTokens,
  writeTokens,
  deleteTokens,
  type Tokens,
} from './tokens';

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-cowork-tokens-test-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

const validTokens: Tokens = {
  access_token: 'access-AAA',
  refresh_token: 'refresh-BBB',
  expires_at: 1_700_000_000_000,
  scope: 'read:sessions write:sessions',
};

describe('tokensFilePath', () => {
  test('returns the documented macOS Application Support path', () => {
    const home = '/Users/test';
    expect(tokensFilePath(home)).toBe(
      '/Users/test/Library/Application Support/tanagram/lore/tokens.json',
    );
  });

  test('defaults to os.homedir() when no override is passed', () => {
    const expected = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'tanagram',
      'lore',
      'tokens.json',
    );
    expect(tokensFilePath()).toBe(expected);
  });
});

describe('TokensSchema', () => {
  test('accepts a well-formed object', () => {
    expect(() => TokensSchema.parse(validTokens)).not.toThrow();
  });

  test('rejects float expires_at (integer-only)', () => {
    const bad = { ...validTokens, expires_at: 1_700_000_000_000.5 };
    expect(() => TokensSchema.parse(bad)).toThrow();
  });

  test('rejects when a required field is missing', () => {
    const noScope: unknown = { access_token: 'a', refresh_token: 'b', expires_at: 1 };
    expect(() => TokensSchema.parse(noScope)).toThrow();
  });

  test('accepts empty scope (the field is required but may be the empty string)', () => {
    const emptyScope = { access_token: 'a', refresh_token: 'b', expires_at: 1, scope: '' };
    expect(() => TokensSchema.parse(emptyScope)).not.toThrow();
  });

  test('rejects wrong-typed fields', () => {
    const bad: unknown = { ...validTokens, access_token: 123 };
    expect(() => TokensSchema.parse(bad)).toThrow();
  });
});

describe('readTokens', () => {
  let home: string;
  beforeEach(() => {
    home = makeTmpHome();
  });
  afterEach(() => {
    rmrf(home);
  });

  test('returns null when the tokens file is absent (and parent dir absent)', async () => {
    expect(await readTokens(home)).toBeNull();
  });

  test('returns null when parent dir exists but file is absent', async () => {
    fs.mkdirSync(path.dirname(tokensFilePath(home)), { recursive: true });
    expect(await readTokens(home)).toBeNull();
  });

  test('returns parsed tokens when the file is well-formed', async () => {
    await writeTokens(validTokens, home);
    const got = await readTokens(home);
    expect(got).toEqual(validTokens);
  });

  test('throws when the file is not valid JSON', async () => {
    const p = tokensFilePath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'not-json-at-all', 'utf8');
    await expect(readTokens(home)).rejects.toThrow();
  });

  test('throws when the JSON does not match the schema', async () => {
    const p = tokensFilePath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ access_token: 1 }), 'utf8');
    await expect(readTokens(home)).rejects.toThrow();
  });

  test('schema-rejection error does not leak token values', async () => {
    const p = tokensFilePath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Malformed: expires_at is a string. The thrown error message must
    // not contain the secret token strings.
    const secret = 'super-secret-access-token-do-not-leak';
    const refreshSecret = 'super-secret-refresh-token-do-not-leak';
    fs.writeFileSync(
      p,
      JSON.stringify({
        access_token: secret,
        refresh_token: refreshSecret,
        expires_at: 'not-a-number',
        scope: 'whatever',
      }),
      'utf8',
    );
    let thrown: unknown;
    try {
      await readTokens(home);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const msg = (thrown as Error).message;
    expect(msg).not.toContain(secret);
    expect(msg).not.toContain(refreshSecret);
  });
});

describe('writeTokens', () => {
  let home: string;
  beforeEach(() => {
    home = makeTmpHome();
  });
  afterEach(() => {
    rmrf(home);
  });

  test('creates the parent directory tree if missing', async () => {
    await writeTokens(validTokens, home);
    const parent = path.dirname(tokensFilePath(home));
    expect(fs.existsSync(parent)).toBe(true);
  });

  test('writes a round-trippable file', async () => {
    await writeTokens(validTokens, home);
    expect(await readTokens(home)).toEqual(validTokens);
  });

  test('sets file mode 0600', async () => {
    await writeTokens(validTokens, home);
    const mode = fs.statSync(tokensFilePath(home)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('sets parent dir mode 0700', async () => {
    await writeTokens(validTokens, home);
    const parent = path.dirname(tokensFilePath(home));
    const mode = fs.statSync(parent).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test('atomicity: a rename failure leaves the original file untouched', async () => {
    const original: Tokens = { ...validTokens, access_token: 'ORIGINAL' };
    await writeTokens(original, home);
    expect(await readTokens(home)).toEqual(original);

    // Monkey-patch fsp.rename to fail. We restore after the test.
    const originalRename = fsp.rename;
    (fsp as unknown as { rename: typeof fsp.rename }).rename = async () => {
      throw new Error('simulated rename failure');
    };
    try {
      const replacement: Tokens = { ...validTokens, access_token: 'REPLACEMENT' };
      await expect(writeTokens(replacement, home)).rejects.toThrow(
        'simulated rename failure',
      );
    } finally {
      (fsp as unknown as { rename: typeof fsp.rename }).rename = originalRename;
    }

    // Original file must still be intact.
    expect(await readTokens(home)).toEqual(original);
  });

  test('concurrent writes never produce a corrupted file', async () => {
    const a: Tokens = { ...validTokens, access_token: 'WRITER-A' };
    const b: Tokens = { ...validTokens, access_token: 'WRITER-B' };
    await Promise.all([writeTokens(a, home), writeTokens(b, home)]);
    // The final file must be exactly one of the two — never a mix.
    const got = await readTokens(home);
    const isA = got?.access_token === 'WRITER-A';
    const isB = got?.access_token === 'WRITER-B';
    expect(isA || isB).toBe(true);
    if (isA) expect(got).toEqual(a);
    if (isB) expect(got).toEqual(b);
  });
});

describe('deleteTokens', () => {
  let home: string;
  beforeEach(() => {
    home = makeTmpHome();
  });
  afterEach(() => {
    rmrf(home);
  });

  test('removes the tokens file if present', async () => {
    await writeTokens(validTokens, home);
    expect(fs.existsSync(tokensFilePath(home))).toBe(true);
    await deleteTokens(home);
    expect(fs.existsSync(tokensFilePath(home))).toBe(false);
  });

  test('is idempotent — no-op when file is absent', async () => {
    await expect(deleteTokens(home)).resolves.toBeUndefined();
  });

  test('does not remove the parent directory', async () => {
    await writeTokens(validTokens, home);
    const parent = path.dirname(tokensFilePath(home));
    await deleteTokens(home);
    expect(fs.existsSync(parent)).toBe(true);
  });
});
