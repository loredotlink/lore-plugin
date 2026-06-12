/**
 * On-disk persistence for plugin-owned state (share counter, watcher tip).
 *
 * Co-located with tokens.json under:
 *   ~/Library/Application Support/tanagram/lore/plugin-state.json
 *
 * Uses the same atomic-write pattern as lib/auth/store.ts (mkdir+0700,
 * write to tmp+0600, fsync, rename) so a crash mid-write never corrupts
 * the file. See store.ts for the full rationale.
 *
 * Schema rejects malformed files (throws). A missing file returns defaults
 * silently — nothing is written until the first successful share.
 *
 * `watcher_prompt_dismissed` exists for a future dismiss flow; today it is
 * always written as `false` on new state and has no setter exposed here.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const PluginStateSchema = z.object({
  share_count: z.number().int().nonnegative(),
  watcher_prompt_dismissed: z.boolean(),
  consent: z
    .enum(['unconsented', 'consented', 'declined', 'installed', 'idle', 'capturing'])
    .default('unconsented'),
});

export type PluginState = z.infer<typeof PluginStateSchema>;
export type ConsentState = PluginState['consent'];

const DEFAULT_STATE: PluginState = {
  share_count: 0,
  watcher_prompt_dismissed: false,
  consent: 'unconsented',
};

/**
 * Absolute path to plugin-state.json, co-located with tokens.json.
 */
export function pluginStateFilePath(home: string = os.homedir()): string {
  return path.join(
    home,
    'Library',
    'Application Support',
    'tanagram',
    'lore',
    'plugin-state.json',
  );
}

/**
 * Load and validate plugin state. Returns defaults if the file does not
 * exist. Throws on I/O errors (other than ENOENT), malformed JSON, or
 * schema validation failures.
 */
export async function readPluginState(home?: string): Promise<PluginState> {
  const p = pluginStateFilePath(home);
  let raw: string;
  try {
    raw = await fsp.readFile(p, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return { ...DEFAULT_STATE };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `plugin-state file at ${p} is not valid JSON: ${(err as Error).message}`,
    );
  }
  const result = PluginStateSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `plugin-state file at ${p} failed schema validation: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Persist plugin state atomically (write-temp + fsync + rename).
 * Parent directory is created at 0700; file is written at 0600.
 */
export async function writePluginState(
  state: PluginState,
  home?: string,
): Promise<void> {
  const p = pluginStateFilePath(home);
  const parent = path.dirname(p);
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
  await fsp.chmod(parent, 0o700);

  const tmp = `${p}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const body = JSON.stringify(state);
  try {
    const fh = await fsp.open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(body, 'utf8');
      await fh.chmod(0o600);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, p);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Returns true if the watcher tip SHOULD be appended this time.
 * Evaluate BEFORE incrementing share_count (tip shows on shares 1, 2, 3;
 * suppressed on 4+).
 */
export function shouldShowWatcherTip(state: PluginState): boolean {
  return state.share_count < 3 && !state.watcher_prompt_dismissed;
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
