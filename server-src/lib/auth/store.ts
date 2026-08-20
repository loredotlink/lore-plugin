/**
 * On-disk persistence for OAuth tokens used by `lore_login` and the
 * cloud-proxy tools.
 *
 * The token format, atomic-write semantics, file permissions, and schema live
 * in the shared `@lore/identity-store` package. This module is
 * the plugin-side adapter: it keeps the established `readTokens` /
 * `writeTokens` / `deleteTokens` / `tokensFilePath` surface (and the `home`
 * override used by tests) but binds every call to the plugin's `plugin` slot,
 *
 * The plugin's pre-consolidation layout
 * (`~/Library/Application Support/tanagram/lore/tokens.json`) is recovered
 * here on first read after upgrade.
 */

import os from 'node:os';
import path from 'node:path';
import {
  type Tokens,
  TokensSchema,
  deleteClientTokens,
  deleteLegacyPluginTokens,
  legacyPluginTokensFile,
  migrateLegacyPluginTokens,
  readClientTokens,
  tokensFilePath as canonicalTokensFilePath,
  writeClientTokens,
} from '@lore/identity-store';

export { TokensSchema, type Tokens };

/** This binary owns the `plugin` slot of the shared `~/.lore/tokens.json`. */
const CLIENT_KEY = 'plugin' as const;

function expandHome(p: string, home: string): string {
  return p.replace(/^~(?=$|\/)/, home);
}

/**
 * Canonical Lore state directory. Production resolves to `~/.lore`, while
 * local/dev harness installs may pass `LORE_DEV_STATE_DIR` so
 * the plugin reads the same client-keyed token file the desktop configured.
 */
export function stateDir(home: string = os.homedir()): string {
  const pluginStateDir = process.env.LORE_PLUGIN_STATE_DIR?.trim();
  if (pluginStateDir) return path.resolve(expandHome(pluginStateDir, home));
  const devStateDir = process.env.LORE_DEV_STATE_DIR?.trim();
  if (devStateDir) return path.resolve(expandHome(devStateDir, home));
  return path.join(home, '.lore');
}

/** Absolute path to the canonical tokens file (`~/.lore/tokens.json`). */
export function tokensFilePath(home: string = os.homedir()): string {
  return canonicalTokensFilePath(stateDir(home));
}

/**
 * Load and validate the plugin's token slot, returning `null` when absent
 * (typical pre-login state).
 *
 * On a canonical miss, recover the plugin's own pre-consolidation Application
 * Support layout once (that file only ever held the plugin's AuthKit token).
 * A corrupt or invalid canonical file degrades to logged-out rather than
 * throwing on the cloud-proxy auth hot path. Recovery requires a new login.
 */
export async function readTokens(home?: string): Promise<Tokens | null> {
  const dir = stateDir(home);
  let current: Tokens | null;
  try {
    current = await readClientTokens(dir, CLIENT_KEY);
  } catch {
    current = null;
  }
  if (current) return current;

  const migrated = migrateLegacyPluginTokens(legacyPluginTokensFile(home));
  if (!migrated) return null;
  await writeClientTokens(dir, CLIENT_KEY, migrated);
  deleteLegacyPluginTokens(home);
  return migrated;
}

/**
 * Persist the plugin's slot atomically, then clear its old token file.
 */
export async function writeTokens(tokens: Tokens, home?: string): Promise<void> {
  const dir = stateDir(home);
  await writeClientTokens(dir, CLIENT_KEY, tokens);
  deleteLegacyPluginTokens(home);
}

/**
 * Remove the plugin's slot and its old token file. No-op when absent.
 */
export async function deleteTokens(home?: string): Promise<void> {
  const dir = stateDir(home);
  await deleteClientTokens(dir, CLIENT_KEY);
  deleteLegacyPluginTokens(home);
}
