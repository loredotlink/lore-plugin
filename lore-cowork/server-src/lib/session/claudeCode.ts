import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nonBlank, type SessionPayload, type SessionSource, type SessionSummary } from './index.js';

/**
 * Default Claude Code projects root on macOS/Linux. Accepts a `home`
 * override for tests.
 */
export function defaultClaudeCodeProjectsRoot(home: string = os.homedir()): string {
  return path.join(home, '.claude', 'projects');
}

/**
 * Encode an absolute cwd the way Claude Code does to build the per-project
 * directory name: replace every '/' with '-'. Example:
 *   '/Users/q/repos/foo' -> '-Users-q-repos-foo'
 */
export function encodeCwdForClaudeCode(cwd: string): string {
  return cwd.split(path.sep).join('-');
}

export type ClaudeCodeSourceOptions = {
  /** Override the projects root. Defaults to `defaultClaudeCodeProjectsRoot()`. */
  projectsRoot?: string;
  /** Override `os.homedir()` for tests when `projectsRoot` isn't set. */
  home?: string;
  /** Override `process.cwd()` for tests. */
  cwd?: string;
};

export class ClaudeCodeSource implements SessionSource {
  readonly runtime = 'claude-code' as const;
  private readonly projectDir: string;

  constructor(opts: ClaudeCodeSourceOptions = {}) {
    const root = opts.projectsRoot ?? defaultClaudeCodeProjectsRoot(opts.home);
    const cwd = opts.cwd ?? process.cwd();
    this.projectDir = path.join(root, encodeCwdForClaudeCode(cwd));
  }

  resolveActive(env: NodeJS.ProcessEnv): SessionSummary {
    const envId = nonBlank(env.CLAUDE_SESSION_ID);
    if (envId === null) {
      throw new Error(
        'no Claude Code session: CLAUDE_SESSION_ID is required when running under Claude Code',
      );
    }
    return this.findById(envId);
  }

  listSessions(): SessionSummary[] {
    if (!fs.existsSync(this.projectDir)) return [];
    const sessions: SessionSummary[] = [];
    for (const entry of fs.readdirSync(this.projectDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const sessionId = entry.name.slice(0, -'.jsonl'.length);
      const filePath = path.join(this.projectDir, entry.name);
      const stat = fs.statSync(filePath);
      sessions.push({
        sessionId,
        sessionDir: this.projectDir,
        mtimeMs: stat.mtimeMs,
      });
    }
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return sessions;
  }

  findById(sessionId: string): SessionSummary {
    const filePath = path.join(this.projectDir, `${sessionId}.jsonl`);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`session not found: ${sessionId}`);
    }
    const stat = fs.statSync(filePath);
    return {
      sessionId,
      sessionDir: this.projectDir,
      mtimeMs: stat.mtimeMs,
    };
  }

  readSession(session: SessionSummary): SessionPayload {
    const transcriptPath = path.join(session.sessionDir, `${session.sessionId}.jsonl`);
    if (!fs.existsSync(transcriptPath) || !fs.statSync(transcriptPath).isFile()) {
      throw new Error(
        `Claude Code session ${session.sessionId} has no transcript file at ${transcriptPath}`,
      );
    }
    return {
      sessionId: session.sessionId,
      transcriptPath,
      transcript: fs.readFileSync(transcriptPath, 'utf8'),
      uploads: [],
      outputs: [],
    };
  }
}
