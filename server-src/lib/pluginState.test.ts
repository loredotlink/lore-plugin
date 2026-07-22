import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  pluginStateFilePath,
  readPluginState,
  writePluginState,
  type PluginState,
} from './pluginState';

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-state-test-'));
}
function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('pluginStateFilePath', () => {
  test('returns co-located path under Library/Application Support/tanagram/lore/', () => {
    const p = pluginStateFilePath('/Users/test');
    expect(p).toBe(
      '/Users/test/Library/Application Support/tanagram/lore/plugin-state.json',
    );
  });

  test('defaults to os.homedir() when home is omitted', () => {
    const p = pluginStateFilePath();
    expect(p).toContain('tanagram/lore/plugin-state.json');
    expect(p).toContain(os.homedir());
  });
});

describe('readPluginState', () => {
  let home: string;
  beforeEach(() => {
    home = makeTmpHome();
  });
  afterEach(() => {
    rmrf(home);
  });

  test('missing file returns defaults without throwing', async () => {
    const state = await readPluginState(home);
    expect(state).toEqual({ share_count: 0 });
  });

  test('reads and validates a well-formed file', async () => {
    const want: PluginState = { share_count: 2 };
    await writePluginState(want, home);
    const got = await readPluginState(home);
    expect(got).toEqual(want);
  });

  test('legacy consent and watcher fields are ignored while share_count is preserved', async () => {
    const p = pluginStateFilePath(home);
    const parent = path.dirname(p);
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({
        share_count: 2,
        watcher_prompt_dismissed: true,
        consent: 'capturing',
      }),
    );
    const got = await readPluginState(home);
    expect(got).toEqual({ share_count: 2 });
  });

  test('schema rejects a file with a negative share_count', async () => {
    const p = pluginStateFilePath(home);
    const parent = path.dirname(p);
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({ share_count: -1 }),
    );
    await expect(readPluginState(home)).rejects.toThrow('schema validation');
  });

  test('schema rejects a file with a float share_count', async () => {
    const p = pluginStateFilePath(home);
    const parent = path.dirname(p);
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({ share_count: 1.5 }),
    );
    await expect(readPluginState(home)).rejects.toThrow('schema validation');
  });

  test('schema rejects a file missing share_count', async () => {
    const p = pluginStateFilePath(home);
    const parent = path.dirname(p);
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ consent: 'unconsented' }));
    await expect(readPluginState(home)).rejects.toThrow('schema validation');
  });

  test('rejects malformed JSON', async () => {
    const p = pluginStateFilePath(home);
    const parent = path.dirname(p);
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(p, 'not-json{{{');
    await expect(readPluginState(home)).rejects.toThrow('not valid JSON');
  });
});

describe('writePluginState', () => {
  let home: string;
  beforeEach(() => {
    home = makeTmpHome();
  });
  afterEach(() => {
    rmrf(home);
  });

  test('round-trips state correctly', async () => {
    const state: PluginState = { share_count: 5 };
    await writePluginState(state, home);
    const got = await readPluginState(home);
    expect(got).toEqual(state);
  });

  test('creates parent directory with mode 0700', async () => {
    await writePluginState({ share_count: 0 }, home);
    const p = pluginStateFilePath(home);
    const dirStat = fs.statSync(path.dirname(p));
    // Check user-only rwx (0o700 in octal = 448 decimal).
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  test('creates file with mode 0600', async () => {
    await writePluginState({ share_count: 0 }, home);
    const p = pluginStateFilePath(home);
    const fileStat = fs.statSync(p);
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  test('increments share_count persistently across calls', async () => {
    let state = await readPluginState(home);
    expect(state.share_count).toBe(0);

    await writePluginState({ ...state, share_count: state.share_count + 1 }, home);
    state = await readPluginState(home);
    expect(state.share_count).toBe(1);

    await writePluginState({ ...state, share_count: state.share_count + 1 }, home);
    state = await readPluginState(home);
    expect(state.share_count).toBe(2);
  });

  test('read is idempotent — two reads return same value without writes in between', async () => {
    await writePluginState({ share_count: 3 }, home);
    const a = await readPluginState(home);
    const b = await readPluginState(home);
    expect(a).toEqual(b);
  });
});
