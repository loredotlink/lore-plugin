import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SESSIONS_DIR_NAME = 'local-agent-mode-sessions';

export type ListedSession = {
  conversationId: string;
  sessionId: string;
  sessionDir: string;
  /** mtime in ms since epoch — used for newest-first ordering. */
  mtimeMs: number;
};

export type SessionContents = {
  /** Absolute path to the transcript file (typically `audit.jsonl`). */
  transcriptPath: string;
  /** Raw bytes of the transcript file as a UTF-8 string. */
  transcript: string;
  /** Filenames (basenames only) found under `<local>/uploads/`. */
  uploads: string[];
  /** Filenames (basenames only) found under `<local>/outputs/`. */
  outputs: string[];
};

const TRANSCRIPT_FILENAME_CANDIDATES = ['audit.jsonl', 'transcript.jsonl'];

/**
 * Default Cowork sessions root on macOS (the only platform Cowork
 * currently ships on). Accepts a `home` override for tests.
 */
export function defaultSessionsRoot(home: string = os.homedir()): string {
  return path.join(home, 'Library', 'Application Support', 'Claude', SESSIONS_DIR_NAME);
}

/**
 * Enumerate every session under the given root, sorted newest-first
 * by directory mtime. Returns an empty array if the root doesn't exist.
 */
export function listSessions(sessionsRoot: string): ListedSession[] {
  if (!fs.existsSync(sessionsRoot)) return [];
  const sessions: ListedSession[] = [];
  for (const conv of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!conv.isDirectory()) continue;
    const convDir = path.join(sessionsRoot, conv.name);
    for (const sess of fs.readdirSync(convDir, { withFileTypes: true })) {
      if (!sess.isDirectory()) continue;
      const sessionDir = path.join(convDir, sess.name);
      const stat = fs.statSync(sessionDir);
      sessions.push({
        conversationId: conv.name,
        sessionId: sess.name,
        sessionDir,
        mtimeMs: stat.mtimeMs,
      });
    }
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions;
}

export function findLatestSession(sessionsRoot: string): ListedSession | null {
  const sessions = listSessions(sessionsRoot);
  return sessions[0] ?? null;
}

/**
 * Read the cowork transcript and artifact filenames out of a session
 * directory at `~/Library/Application Support/Claude/local-agent-mode-sessions/<conv>/<sess>/`.
 *
 * Layout (sampled from a real session):
 *   <sessionDir>/
 *     local_<id>/
 *       audit.jsonl       <-- transcript (envelope-wrapped JSONL)
 *       uploads/<file>
 *       outputs/<file>
 *     local_<id>.json      <-- session manifest (we don't read it in v1)
 *     ...                  <-- other auxiliary files (cowork-gb-cache.json, .DS_Store, etc.)
 *
 * Throws with a clear, actionable message when:
 *   - the session has no `local_*` subdirectory
 *   - the `local_*` subdirectory has no recognised transcript file
 */
export function readSession(sessionDir: string): SessionContents {
  const localDir = findLocalSubdir(sessionDir);
  if (!localDir) {
    throw new Error(
      `Session ${sessionDir} has no local_* subdirectory — is this a Cowork session?`,
    );
  }
  const transcriptPath = findTranscriptFile(localDir);
  if (!transcriptPath) {
    throw new Error(
      `Session ${sessionDir} has no transcript file under ${localDir} ` +
        `(looked for ${TRANSCRIPT_FILENAME_CANDIDATES.join(', ')})`,
    );
  }
  const transcript = fs.readFileSync(transcriptPath, 'utf8');
  const uploads = listFilesInSubdir(localDir, 'uploads');
  const outputs = listFilesInSubdir(localDir, 'outputs');
  return { transcriptPath, transcript, uploads, outputs };
}

/**
 * A Cowork session directory often contains many sibling `local_*`
 * chats (each its own conversation). The active chat is the one whose
 * transcript file was most recently written. We can't use the
 * `local_*` directory's mtime because appending to `audit.jsonl`
 * doesn't update the enclosing directory's mtime on macOS — only the
 * file itself ticks forward. So rank by the newest transcript-file
 * mtime, falling back to dir mtime when no transcript exists yet
 * (brand-new chat).
 */
function findLocalSubdir(sessionDir: string): string | null {
  if (!fs.existsSync(sessionDir)) return null;
  const entries = fs.readdirSync(sessionDir, { withFileTypes: true });
  let best: { dir: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('local_')) continue;
    const dir = path.join(sessionDir, entry.name);
    const transcriptPath = findTranscriptFile(dir);
    let mtimeMs: number;
    if (transcriptPath) {
      mtimeMs = fs.statSync(transcriptPath).mtimeMs;
    } else {
      mtimeMs = fs.statSync(dir).mtimeMs;
    }
    if (!best || mtimeMs > best.mtimeMs) {
      best = { dir, mtimeMs };
    }
  }
  return best?.dir ?? null;
}

function findTranscriptFile(localDir: string): string | null {
  for (const candidate of TRANSCRIPT_FILENAME_CANDIDATES) {
    const p = path.join(localDir, candidate);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

function listFilesInSubdir(localDir: string, subdir: string): string[] {
  const dir = path.join(localDir, subdir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}
