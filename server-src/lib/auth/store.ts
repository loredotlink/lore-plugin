/**
 * On-disk persistence for OAuth tokens used by `lore_login` and the
 * cloud-proxy tools.
 *
 * The token format, atomic-write semantics, file permissions, and schema now
 * live in the shared `@lore/identity-store` package so the plugin and the CLI
 * use ONE identity: a login performed by either is recognized by the other
 * (ADR-0002 Phase 0). This module is the plugin-side adapter — it keeps the
 * established `readTokens` / `writeTokens` / `deleteTokens` / `tokensFilePath`
 * surface (and the `home` override used by tests) but points the shared store
 * at the canonical `~/.lore` directory that the CLI owns.
 *
 * Migration: both pre-consolidation layouts (the plugin's
 * `~/Library/Application Support/tanagram/lore/tokens.json` AND the CLI's
 * `~/.lore/token` + `refresh_token`) are migrated into `~/.lore/tokens.json` on
 * first read after upgrade — whichever client reads first, so a login through
 * either is recognized. The legacy-layout knowledge and the unified
 * migrate/clear helpers live in `@lore/identity-store`.
 */

import os from 'node:os';
import path from 'node:path';
import {
  type Tokens,
  TokensSchema,
  deleteLegacyTokens,
  deleteTokens as deleteCanonicalTokens,
  migrateLegacyTokens,
  readTokens as readCanonicalTokens,
  tokensFilePath as canonicalTokensFilePath,
  writeTokens as writeCanonicalTokens,
} from '@lore/identity-store';

export { TokensSchema, type Tokens };

/**
 * Canonical Lore state directory (`~/.lore`). Shared with the CLI; the plugin
 * ships on macOS only but `~/.lore` is the CLI's cross-platform home, so both
 * clients resolve to the same path in production.
 */
function stateDir(home: string = os.homedir()): string {
  return path.join(home, '.lore');
}

/** Absolute path to the canonical tokens file (`~/.lore/tokens.json`). */
export function tokensFilePath(home: string = os.homedir()): string {
  return canonicalTokensFilePath(stateDir(home));
}

/**
 * Load and validate the tokens file, returning `null` when absent (typical
 * pre-login state). On a canonical miss, migrate from EITHER legacy layout once.
 *
 * A corrupt/invalid canonical file degrades to logged-out rather than throwing
 * on the cloud-proxy auth hot path (symmetric with the CLI); recovery is
 * re-login, which overwrites the file. We still fall through to legacy
 * migration so valid pre-consolidation credentials can recover the session.
 */
export async function readTokens(home?: string): Promise<Tokens | null> {
  const dir = stateDir(home);
  let current: Tokens | null;
  try {
    current = await readCanonicalTokens(dir);
  } catch {
    current = null;
  }
  if (current) return current;

  const migrated = migrateLegacyTokens(dir, home);
  if (!migrated) return null;
  await writeCanonicalTokens(dir, migrated);
  deleteLegacyTokens(dir, home);
  return migrated;
}

/**
 * Persist tokens atomically to the canonical store, then clear all legacy
 * layouts: the fresh canonical file is now the source of truth, so leftover
 * legacy files must not survive to be re-migrated by either client.
 */
export async function writeTokens(tokens: Tokens, home?: string): Promise<void> {
  const dir = stateDir(home);
  await writeCanonicalTokens(dir, tokens);
  deleteLegacyTokens(dir, home);
}

/**
 * Remove the canonical tokens file plus every legacy layout in play — the
 * plugin's old Application Support file *and* the CLI's pre-consolidation
 * `token`/`refresh_token` files. Clearing both matters because either client
 * would otherwise re-migrate a leftover on its next read and resurrect a
 * session the user just logged out of. No-op when absent.
 */
export async function deleteTokens(home?: string): Promise<void> {
  const dir = stateDir(home);
  await deleteCanonicalTokens(dir);
  deleteLegacyTokens(dir, home);
}
