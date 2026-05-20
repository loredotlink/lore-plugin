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
 * directory name. Claude Code replaces any character outside
 * `[A-Za-z0-9_-]` with `-`, which means BOTH path separators and dots
 * collapse to dashes — consecutive specials produce consecutive dashes.
 *
 * Examples (verified against `~/.claude/projects/` entries on macOS):
 *   '/Users/q/repos/foo'              -> '-Users-q-repos-foo'
 *   '/Users/q/.config/amp'            -> '-Users-q--config-amp'   (note the double dash)
 *   '/Users/q/repos/lore/.claude/wt'  -> '-Users-q-repos-lore--claude-wt'
 *
 * The previous implementation only replaced `/`, leaving literal dots
 * intact (e.g. `-Users-q-.config-amp`). That looks plausible but
 * doesn't match what Claude Code writes to disk, so the plugin's
 * ClaudeCodeSource was reading from a directory that did not exist,
 * silently returning an empty `listSessions()` and forcing the
 * runtime detection to fall through to Cowork. Replacing every
 * non-alphanumeric (and non-`_`/-`-`) character keeps the encoder
 * aligned with Claude Code's own implementation.
 */
export function encodeCwdForClaudeCode(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9_-]/g, '-');
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
    // Resolution order for the cwd that maps to the Claude Code project
    // directory:
    //   1. Explicit `opts.cwd` — tests, advanced callers.
    //   2. `CLAUDE_PROJECT_DIR` env var — set by Claude Code when it
    //      launches MCP stdio children. More reliable than `process.cwd()`
    //      because Claude Code may run the child from a different
    //      directory than the project root.
    //   3. `process.cwd()` — last resort, used when the plugin is run
    //      outside Claude Code (e.g. a developer invoking the binary
    //      directly during testing).
    const cwd =
      opts.cwd ?? nonBlank(process.env.CLAUDE_PROJECT_DIR) ?? process.cwd();
    this.projectDir = path.join(root, encodeCwdForClaudeCode(cwd));
  }

  resolveActive(env: NodeJS.ProcessEnv): SessionSummary {
    const envId = nonBlank(env.CLAUDE_SESSION_ID);
    if (envId !== null) return this.findById(envId);

    // Fallback: newest-by-mtime jsonl in the project directory. Mirrors
    // CoworkSource's behavior when COWORK_SESSION_ID is absent.
    //
    // Why this fallback exists: Claude Code (as of May 2026) does NOT
    // inject `CLAUDE_SESSION_ID` into MCP stdio children, even though
    // `CLAUDE_PROJECT_DIR` IS set. Without this fallback, every Claude
    // Code invocation of the plugin would fail to resolve a session
    // and silently fall through to Cowork via `detectSource()`,
    // sharing whatever Cowork session happened to be most recent —
    // not the user's current Claude Code conversation. The newest
    // jsonl in the project dir is the best heuristic for "current
    // session" when no explicit id is provided.
    const all = this.listSessions();
    const latest = all[0];
    if (!latest) {
      throw new Error(
        `no Claude Code session found in ${this.projectDir} — ` +
          'has Claude Code logged any session for this project yet?',
      );
    }
    return latest;
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
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      throw new Error(`session not found: ${sessionId}`);
    }
    if (!stat.isFile()) {
      throw new Error(`session not found: ${sessionId}`);
    }
    return {
      sessionId,
      sessionDir: this.projectDir,
      mtimeMs: stat.mtimeMs,
    };
  }

  readSession(session: SessionSummary): SessionPayload {
    const transcriptPath = path.join(session.sessionDir, `${session.sessionId}.jsonl`);
    let transcript: string;
    try {
      const stat = fs.statSync(transcriptPath);
      if (!stat.isFile()) throw new Error('not a file');
      transcript = fs.readFileSync(transcriptPath, 'utf8');
    } catch {
      throw new Error(
        `Claude Code session ${session.sessionId} has no transcript file at ${transcriptPath}`,
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
