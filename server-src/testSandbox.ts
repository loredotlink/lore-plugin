/**
 * Test-suite sandbox for the real Lore state dir (TAN-5045).
 *
 * `bun test` runs every `*.test.ts` in this package inside ONE process. Some
 * modules (notably `amp/lore.ts`) run filesystem-touching side effects at
 * import time, and `stateDir()` treats an absolute `LORE_PLUGIN_STATE_DIR` as
 * an override that WINS over any explicit `home` argument. The historical
 * failure mode: importing the Amp plugin module set `LORE_PLUGIN_STATE_DIR` to
 * the developer's real `~/.lore`, which then silently redirected every other
 * test's token write onto the developer's real credentials — logging them out.
 *
 * This module is the enforcement layer. `armRealLoreWriteGuard()` (called by
 * the bun-test preload) patches the mutating `fs`/`fs/promises` entry points so
 * any write targeting the real `~/.lore` throws loudly instead of corrupting
 * real state. It has NO top-level side effects, so tests can import the pure
 * `isInsideRealLore` / `realLoreStateDir` helpers without arming anything.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * The real, per-user Lore state dir the test suite must never write into.
 * Uses `os.homedir()` (not `process.env.HOME`) because Bun's `os.homedir()`
 * reads the OS passwd and ignores `HOME` — matching how production resolves it.
 */
export function realLoreStateDir(): string {
  return path.join(os.homedir(), '.lore');
}

/** True when `target` resolves to the real `~/.lore` dir or anything inside it. */
export function isInsideRealLore(target: unknown): boolean {
  let resolved: string;
  try {
    resolved = path.resolve(String(target));
  } catch {
    return false;
  }
  const real = realLoreStateDir();
  return resolved === real || resolved.startsWith(real + path.sep);
}

function blocked(op: string, target: unknown): never {
  throw new Error(
    `[lore-plugin test sandbox] Blocked ${op} into the real Lore state dir ` +
      `(${realLoreStateDir()}). A test tried to write outside its tmp home — ` +
      `almost always LORE_PLUGIN_STATE_DIR pollution from a module-load side ` +
      `effect (TAN-5045). Target: ${String(target)}`,
  );
}

let armed = false;

/**
 * Idempotently patch the mutating fs entry points so writes into the real
 * `~/.lore` throw. Read-only ops are left alone; only creation/mutation is
 * intercepted, at the earliest point in each write path (`mkdir` runs before
 * the temp-file write in the atomic-write helpers).
 */
export function armRealLoreWriteGuard(): void {
  if (armed) return;
  armed = true;

  type AnyFn = (...args: unknown[]) => unknown;

  // Sync ops throw synchronously — matching their native contract.
  const patchSync = (obj: object, name: string, indices: number[] = [0]): void => {
    const rec = obj as Record<string, AnyFn>;
    const original = rec[name];
    rec[name] = function (this: unknown, ...args: unknown[]): unknown {
      for (const i of indices) {
        if (isInsideRealLore(args[i])) blocked(name, args[i]);
      }
      return original.apply(this, args);
    } as AnyFn;
  };

  // Async ops must REJECT, never throw synchronously: callers rely on
  // `fsp.x(...)` always returning a promise. An `async` wrapper turns the
  // thrown guard error into a rejection.
  const patchAsync = (obj: object, name: string, indices: number[] = [0]): void => {
    const rec = obj as Record<string, AnyFn>;
    const original = rec[name];
    rec[name] = async function (this: unknown, ...args: unknown[]): Promise<unknown> {
      for (const i of indices) {
        if (isInsideRealLore(args[i])) blocked(name, args[i]);
      }
      return original.apply(this, args);
    } as AnyFn;
  };

  // Async (plugin) path. `rename(from, to)` puts the destination at index 1;
  // the atomic-write temp file also lives inside the target dir, so guard both.
  patchAsync(fsp, 'mkdir');
  patchAsync(fsp, 'writeFile');
  patchAsync(fsp, 'rm');
  patchAsync(fsp, 'unlink');
  patchAsync(fsp, 'open');
  patchAsync(fsp, 'rename', [0, 1]);

  // Sync (CLI) path.
  patchSync(fs, 'mkdirSync');
  patchSync(fs, 'writeFileSync');
  patchSync(fs, 'rmSync');
  patchSync(fs, 'unlinkSync');
  patchSync(fs, 'openSync');
  patchSync(fs, 'renameSync', [0, 1]);
}
