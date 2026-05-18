import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionPayload, SessionSource, SessionSummary } from './index.js';

export const SESSIONS_DIR_NAME = 'local-agent-mode-sessions';
const TRANSCRIPT_FILENAME_CANDIDATES = ['audit.jsonl', 'transcript.jsonl'];

/**
 * Default Cowork sessions root on macOS. Accepts a `home` override
 * for tests.
 */
export function defaultCoworkSessionsRoot(home: string = os.homedir()): string {
  return path.join(home, 'Library', 'Application Support', 'Claude', SESSIONS_DIR_NAME);
}

export type CoworkSourceOptions = {
  /** Override the sessions root. Defaults to `defaultCoworkSessionsRoot()`. */
  sessionsRoot?: string;
  /** Override `os.homedir()` for tests when `sessionsRoot` isn't set. */
  home?: string;
};

export class CoworkSource implements SessionSource {
  readonly runtime = 'cowork' as const;
  private readonly sessionsRoot: string;

  constructor(opts: CoworkSourceOptions = {}) {
    this.sessionsRoot = opts.sessionsRoot ?? defaultCoworkSessionsRoot(opts.home);
  }

  resolveActive(env: NodeJS.ProcessEnv): SessionSummary {
    const envId = nonBlank(env.COWORK_SESSION_ID);
    if (envId !== null) return this.findById(envId);

    const all = this.listSessions();
    const latest = all[0];
    if (!latest) {
      throw new Error('no Cowork session found');
    }
    return latest;
  }

  listSessions(): SessionSummary[] {
    if (!fs.existsSync(this.sessionsRoot)) return [];
    const sessions: SessionSummary[] = [];
    for (const conv of fs.readdirSync(this.sessionsRoot, { withFileTypes: true })) {
      if (!conv.isDirectory()) continue;
      const convDir = path.join(this.sessionsRoot, conv.name);
      for (const sess of fs.readdirSync(convDir, { withFileTypes: true })) {
        if (!sess.isDirectory()) continue;
        const sessionDir = path.join(convDir, sess.name);
        const stat = fs.statSync(sessionDir);
        sessions.push({
          sessionId: sess.name,
          conversationId: conv.name,
          sessionDir,
          mtimeMs: stat.mtimeMs,
        });
      }
    }
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return sessions;
  }

  findById(sessionId: string): SessionSummary {
    const match = this.listSessions().find((s) => s.sessionId === sessionId);
    if (!match) {
      throw new Error(`session not found: ${sessionId}`);
    }
    return match;
  }

  readSession(session: SessionSummary): SessionPayload {
    const localDir = findLocalSubdir(session.sessionDir);
    if (!localDir) {
      throw new Error(
        `Session ${session.sessionDir} has no local_* subdirectory — is this a Cowork session?`,
      );
    }
    const transcriptPath = findTranscriptFile(localDir);
    if (!transcriptPath) {
      throw new Error(
        `Session ${session.sessionDir} has no transcript file under ${localDir} ` +
          `(looked for ${TRANSCRIPT_FILENAME_CANDIDATES.join(', ')})`,
      );
    }
    return {
      sessionId: session.sessionId,
      conversationId: session.conversationId,
      transcriptPath,
      transcript: fs.readFileSync(transcriptPath, 'utf8'),
      uploads: listFilesInSubdir(localDir, 'uploads'),
      outputs: listFilesInSubdir(localDir, 'outputs'),
    };
  }
}

function nonBlank(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function findLocalSubdir(sessionDir: string): string | null {
  if (!fs.existsSync(sessionDir)) return null;
  const entries = fs.readdirSync(sessionDir, { withFileTypes: true });
  let best: { dir: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('local_')) continue;
    const dir = path.join(sessionDir, entry.name);
    const transcriptPath = findTranscriptFile(dir);
    const mtimeMs = transcriptPath
      ? fs.statSync(transcriptPath).mtimeMs
      : fs.statSync(dir).mtimeMs;
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
