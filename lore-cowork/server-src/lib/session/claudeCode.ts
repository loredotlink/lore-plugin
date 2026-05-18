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

  resolveActive(_env: NodeJS.ProcessEnv): SessionSummary {
    throw new Error('ClaudeCodeSource.resolveActive: not yet implemented');
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

  findById(_sessionId: string): SessionSummary {
    throw new Error('ClaudeCodeSource.findById: not yet implemented');
  }

  readSession(_session: SessionSummary): SessionPayload {
    throw new Error('ClaudeCodeSource.readSession: not yet implemented');
  }
}
