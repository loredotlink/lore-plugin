/**
 * On-disk persistence for OAuth tokens used by `lore_login` and the
 * cloud-proxy tools.
 *
 * Why a dedicated module:
 *   Both the login flow (`tools/lore_login.ts`) and the auto-refresh
 *   helper (`lib/auth/refresh.ts`) read and mutate the same tokens file.
 *   Centralizing schema validation, atomic-write semantics, and file
 *   permissions here is the only way to keep those two callers in sync
 *   without copy-pasting the trickier bits.
 *
 * Why atomic writes:
 *   The refresh path replaces the tokens file in place every time the
 *   access token rotates. A power loss or process kill mid-write would
 *   otherwise leave a truncated/corrupted file on disk, breaking every
 *   subsequent cloud call. The write-temp + fsync + rename idiom
 *   guarantees that readers either see the previous complete file or
 *   the new complete file — never a mix.
 *
 * Why 0600 / 0700:
 *   The tokens file contains an OAuth refresh token, which is a
 *   long-lived bearer credential. Both the file (0600) and its parent
 *   directory (0700) are locked to user-only access so that other
 *   accounts on a shared machine — including most other processes that
 *   share the user's filesystem view — cannot read it. We `chmod`
 *   explicitly after `mkdir`/`writeFile` because both `mkdir`'s `mode`
 *   option and `writeFile`'s `mode` option are masked by the process's
 *   `umask`; only an explicit `chmod` is guaranteed to land the bits we
 *   want.
 *
 * Why a `home` override:
 *   Tests need to write under `os.tmpdir()` without polluting the
 *   real `~/Library/Application Support/` tree. Every public function
 *   accepts an optional `home` parameter that defaults to
 *   `os.homedir()`; production callers pass nothing.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/**
 * Schema for the on-disk tokens file.
 *
 * Notes on individual fields:
 *   - `expires_at` is epoch milliseconds (not seconds, not ISO). It must
 *     be an integer; floats are a sign someone confused ms with seconds
 *     (or vice versa) and we'd rather fail loud than silently truncate.
 *   - `scope` is the space-separated scope string associated with the token.
 *     AuthKit may omit `scope` from token responses, so callers may persist the
 *     requested scope string instead of a server-echoed value.
 */
export const TokensSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.number().int(),
  scope: z.string(),
});

export type Tokens = z.infer<typeof TokensSchema>;

/**
 * Absolute path to the tokens file under
 * `~/Library/Application Support/tanagram/lore/tokens.json`.
 *
 * Why this specific path:
 *   - `tanagram/lore/` keeps the plugin's auth state alongside the
 *     cloud CLI's data without colliding with Cowork's session
 *     directory under `Claude/local-agent-mode-sessions/`.
 *   - `Application Support` is the macOS-sanctioned home for opaque
 *     per-user state; the plugin currently only ships on macOS.
 */
export function tokensFilePath(home: string = os.homedir()): string {
  return path.join(home, 'Library', 'Application Support', 'tanagram', 'lore', 'tokens.json');
}

/**
 * Load and validate the tokens file.
 *
 * Returns `null` if the file does not exist (typical pre-login state).
 * Throws on every other failure mode — I/O errors, malformed JSON,
 * schema-validation failures — because callers (the refresh path, the
 * proxy tools) cannot do anything useful with partial token data and
 * we'd rather surface the problem than silently re-auth.
 *
 * The thrown error from a schema failure references the failing fields
 * via Zod's standard error message; it deliberately does NOT include
 * the raw input, so a malformed tokens file cannot leak token strings
 * into stderr via an unhandled rejection.
 */
export async function readTokens(home?: string): Promise<Tokens | null> {
  const p = tokensFilePath(home);
  let raw: string;
  try {
    raw = await fsp.readFile(p, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Don't include `raw` in the message — it contains token strings.
    throw new Error(
      `tokens file at ${p} is not valid JSON: ${(err as Error).message}`,
    );
  }
  const result = TokensSchema.safeParse(parsed);
  if (!result.success) {
    // Zod's default issue messages reference paths and expected types
    // but not the failing values themselves, so this is safe to surface.
    throw new Error(
      `tokens file at ${p} failed schema validation: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Persist tokens atomically.
 *
 * The sequence is:
 *   1. mkdir -p the parent directory (mode 0700).
 *   2. Write to `<path>.tmp` with mode 0600.
 *   3. fsync the temp file so the bytes are durable in the page cache's
 *      stable-write sense — without this, a crash between rename and
 *      the next fsync could expose a zero-length file.
 *   4. Rename `<path>.tmp` → `<path>`. On POSIX filesystems this is
 *      atomic: a concurrent reader sees either the old inode or the
 *      new one, never a half-written file.
 *
 * If any step fails we leave the previous tokens file untouched. The
 * temp file is best-effort unlinked on any failure between its creation
 * and the successful rename (writeFile, chmod, fsync, or rename), so
 * the parent directory doesn't accumulate orphaned `tokens.json.tmp.*`
 * files on a partially-full disk or a chmod-restricted filesystem.
 * Cleanup errors are swallowed because the original failure is the
 * signal the caller cares about.
 */
export async function writeTokens(tokens: Tokens, home?: string): Promise<void> {
  const p = tokensFilePath(home);
  const parent = path.dirname(p);
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask; chmod explicitly to lock it in.
  await fsp.chmod(parent, 0o700);

  // The temp filename is suffixed with the process id so two concurrent
  // `writeTokens` calls within the same process don't clobber each
  // other's intermediate file. Within a single process, the in-flight
  // writes still resolve in some order; whichever rename wins last is
  // what readers see.
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const body = JSON.stringify(tokens);
  try {
    const fh = await fsp.open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(body, 'utf8');
      // Belt-and-braces: chmod after write in case the umask masked the
      // open-time mode bits.
      await fh.chmod(0o600);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, p);
  } catch (err) {
    // Best-effort cleanup of the temp file so it doesn't accumulate on
    // any failure between open and rename (writeFile, chmod, fsync, or
    // rename). Swallow cleanup errors — including ENOENT, if the temp
    // file was never created — because the original failure is the
    // signal the caller cares about.
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Remove the tokens file if it exists. No-op if absent. Does not touch
 * the parent directory — leaving the (already user-locked) directory
 * in place means the next login doesn't have to re-establish the 0700
 * mode bits.
 */
export async function deleteTokens(home?: string): Promise<void> {
  const p = tokensFilePath(home);
  try {
    await fsp.unlink(p);
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
