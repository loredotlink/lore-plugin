import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isInsideRealLore, realLoreStateDir } from './testSandbox';

// These tests lock in the suite-wide guarantee behind TAN-5045: the plugin
// test suite must be INCAPABLE of writing into the developer's real ~/.lore.
// The guard is armed by the bun-test preload (`bunfig.toml` → testSandbox.ts).

describe('real ~/.lore write guard (TAN-5045)', () => {
  test('isInsideRealLore flags the canonical tokens file but not tmp paths', () => {
    expect(isInsideRealLore(path.join(realLoreStateDir(), 'tokens.json'))).toBe(true);
    expect(isInsideRealLore(realLoreStateDir())).toBe(true);
    expect(isInsideRealLore(path.join(os.tmpdir(), 'lore-test', '.lore', 'tokens.json'))).toBe(false);
  });

  test('a synchronous write into the real ~/.lore throws (tripwire is armed)', () => {
    const probe = path.join(realLoreStateDir(), '__sandbox_write_probe__');
    try {
      expect(() => fs.mkdirSync(probe, { recursive: true })).toThrow(/test sandbox/i);
    } finally {
      // Belt-and-suspenders: if the guard were somehow disarmed and the probe
      // dir got created, remove it. Never touches tokens.json.
      try {
        fs.rmdirSync(probe);
      } catch {
        // expected: guard blocked creation, so nothing to remove.
      }
    }
  });

  test('an asynchronous write into the real ~/.lore rejects (tripwire is armed)', async () => {
    const probe = path.join(realLoreStateDir(), '__sandbox_write_probe_async__');
    try {
      await expect(fsp.mkdir(probe, { recursive: true })).rejects.toThrow(/test sandbox/i);
    } finally {
      await fsp.rmdir(probe).catch(() => {});
    }
  });
});
