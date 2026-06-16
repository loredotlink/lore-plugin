/**
 * On-disk persistence for OAuth tokens used by `lore_login` and the
 * cloud-proxy tools.
 *
 * The token format, atomic-write semantics, file permissions, and schema live
 * in the shared `@lore/identity-store` package so the plugin and the CLI share
 * ONE file with per-client slots (ADR-0002 Phase 0, ADR-0008). This module is
 * the plugin-side adapter: it keeps the established `readTokens` /
 * `writeTokens` / `deleteTokens` / `tokensFilePath` surface (and the `home`
 * override used by tests) but binds every call to the plugin's `plugin` slot,
 * so a CLI login/refresh never clobbers the plugin's tokens and vice versa.
 *
 * Migration: a flat pre-v2 `~/.lore/tokens.json` is routed to the `plugin`
 * slot on read by `@lore/identity-store` when it looks like an AuthKit token.
 * The plugin's own pre-consolidation layout
 * (`~/Library/Application Support/tanagram/lore/tokens.json`) is recovered
 * here on first read after upgrade.
 */

import os from 'node:os';
import path from 'node:path';
import {
  type Tokens,
  TokensSchema,
  deleteClientTokens,
  deleteLegacyTokens,
  legacyPluginTokensFile,
  migrateLegacyPluginTokens,
  readClientTokens,
  tokensFilePath as canonicalTokensFilePath,
  writeClientTokens,
} from '@lore/identity-store';

export { TokensSchema, type Tokens };

/** This binary owns the `plugin` slot of the shared `~/.lore/tokens.json`. */
const CLIENT_KEY = 'plugin' as const;

/**
 * Canonical Lore state directory (`~/.lore`). Shared with the CLI; the plugin
 * ships on macOS only but `~/.lore` is the CLI's cross-platform home, so both
 * clients resolve to the same path in production.
 */
export function stateDir(home: string = os.homedir()): string {
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
 * The legacy CLI two-file layout is deliberately NOT adopted here: it holds a
 * WorkOS User Management token belonging to the CLI, and the CLI now owns its
 * own slot (TAN-4329). A corrupt/invalid canonical file degrades to logged-out
 * rather than throwing on the cloud-proxy auth hot path (symmetric with the
 * CLI); recovery is re-login.
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
  deleteLegacyTokens(dir, home);
  return migrated;
}

/**
 * Persist the plugin's slot atomically (preserving the CLI's slot), then clear
 * all legacy layouts: the v2 file is now the source of truth, so leftover
 * legacy files must not survive to be re-migrated by either client.
 */
export async function writeTokens(tokens: Tokens, home?: string): Promise<void> {
  const dir = stateDir(home);
  await writeClientTokens(dir, CLIENT_KEY, tokens);
  deleteLegacyTokens(dir, home);
}

/**
 * Remove the plugin's slot (leaving the CLI's slot intact) plus every legacy
 * layout. Clearing legacy matters because either client would otherwise
 * re-migrate a leftover on its next read and resurrect a session the user just
 * logged out of. No-op when absent.
 */
export async function deleteTokens(home?: string): Promise<void> {
  const dir = stateDir(home);
  await deleteClientTokens(dir, CLIENT_KEY);
  deleteLegacyTokens(dir, home);
}
