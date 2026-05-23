import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nonBlank, type SessionPayload, type SessionSource, type SessionSummary } from './index.js';

/**
 * Default Codex sessions root on macOS/Linux. Accepts a `home`
 * override for tests.
 */
export function defaultCodexSessionsRoot(home: string = os.homedir()): string {
  return path.join(home, '.codex', 'sessions');
}

export type CodexSourceOptions = {
  /** Override the sessions root. Defaults to `defaultCodexSessionsRoot()`. */
  sessionsRoot?: string;
  /** Override `os.homedir()` for tests when `sessionsRoot` isn't set. */
  home?: string;
};

export class CodexSource implements SessionSource {
  readonly runtime = 'codex' as const;
  private readonly sessionsRoot: string;

  constructor(opts: CodexSourceOptions = {}) {
    this.sessionsRoot = opts.sessionsRoot ?? defaultCodexSessionsRoot(opts.home);
  }

  resolveActive(env: NodeJS.ProcessEnv): SessionSummary {
    const envId =
      nonBlank(env.CODEX_THREAD_ID) ?? nonBlank(env.CODEX_SESSION_ID);
    if (envId !== null) return this.findById(envId);

    const all = this.listSessions();
    const latest = all[0];
    if (!latest) {
      throw new Error('no Codex session found');
    }
    return latest;
  }

  listSessions(): SessionSummary[] {
    if (!fs.existsSync(this.sessionsRoot)) return [];

    const sessions: SessionSummary[] = [];
    for (const transcriptPath of walkJsonlFiles(this.sessionsRoot)) {
      const stat = fs.statSync(transcriptPath);
      sessions.push({
        sessionId: readCodexSessionId(transcriptPath),
        sessionDir: path.dirname(transcriptPath),
        transcriptPath,
        mtimeMs: stat.mtimeMs,
      });
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
    const transcriptPath = session.transcriptPath;
    if (!transcriptPath) {
      throw new Error(
        `Codex session ${session.sessionId} has no transcript path recorded`,
      );
    }

    let transcript: string;
    try {
      const stat = fs.statSync(transcriptPath);
      if (!stat.isFile()) throw new Error('not a file');
      transcript = fs.readFileSync(transcriptPath, 'utf8');
    } catch {
      throw new Error(
        `Codex session ${session.sessionId} has no transcript file at ${transcriptPath}`,
      );
    }

    return {
      sessionId: session.sessionId,
      transcriptPath,
      transcript,
      uploads: [],
      outputs: [],
    };
  }
}

function walkJsonlFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function readCodexSessionId(transcriptPath: string): string {
  const firstLine = readFirstLine(transcriptPath);
  if (firstLine !== null) {
    try {
      const parsed = JSON.parse(firstLine) as {
        payload?: { id?: unknown };
      };
      const id = nonBlank(parsed.payload?.id);
      if (id !== null) return id;
    } catch {
      // Fall back to the filename-derived id below.
    }
  }

  return inferSessionIdFromFilename(transcriptPath);
}

function readFirstLine(filePath: string, maxBytes = 16 * 1024): string | null {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) return null;
    const chunk = buffer.toString('utf8', 0, bytesRead);
    const newlineIndex = chunk.indexOf('\n');
    const firstLine = newlineIndex === -1 ? chunk : chunk.slice(0, newlineIndex);
    const trimmed = firstLine.trim();
    return trimmed === '' ? null : trimmed;
  } finally {
    fs.closeSync(fd);
  }
}

function inferSessionIdFromFilename(transcriptPath: string): string {
  const base = path.basename(transcriptPath, '.jsonl');
  const uuidSuffix =
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
  const match = base.match(uuidSuffix);
  return match?.[1] ?? base;
}
