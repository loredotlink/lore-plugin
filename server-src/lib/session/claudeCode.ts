import fs from 'node:fs';
import path from 'node:path';
import { claudeProjectsRoot, encodeCwdToDir } from '@lore/transcript-locate';
import { nonBlank, type SessionPayload, type SessionSource, type SessionSummary } from './index.js';

export type ClaudeCodeSourceOptions = {
  /** Override the projects root. Defaults to `claudeProjectsRoot()`. */
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
    const root = opts.projectsRoot ?? claudeProjectsRoot(opts.home);
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
    this.projectDir = path.join(root, encodeCwdToDir(cwd));
  }

  resolveActive(env: NodeJS.ProcessEnv): SessionSummary {
    // Resolution order:
    //   1. `CLAUDE_CODE_SESSION_ID` — the env var Claude Code actually
    //      injects into MCP stdio children (note the `CODE` in the
    //      middle; the matching `CLAUDECODE=1` flag confirms the
    //      namespace).
    //   2. `CLAUDE_SESSION_ID` — back-compat alias for callers or
    //      future Claude Code versions that adopt the shorter name.
    //   3. Newest-by-mtime jsonl in the project directory.
    //
    // Why both env vars are read: the mtime fallback is racy when
    // multiple sessions exist in the same project (background tasks,
    // other tabs, hooks all touch jsonl files), so the explicit env
    // id is strongly preferred. Claude Code's own var name is
    // `CLAUDE_CODE_SESSION_ID`, but older docs and sibling runtimes
    // sometimes reference `CLAUDE_SESSION_ID`; honor both.
    const envId =
      nonBlank(env.CLAUDE_CODE_SESSION_ID) ?? nonBlank(env.CLAUDE_SESSION_ID);
    if (envId !== null) return this.findById(envId);

    // Last-resort fallback: newest-by-mtime jsonl. Mirrors
    // CoworkSource's behavior when COWORK_SESSION_ID is absent.
    // Kept for environments where neither env var is set (e.g. the
    // plugin binary invoked directly outside Claude Code).
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
        transcriptPath: filePath,
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
      transcriptPath: filePath,
      mtimeMs: stat.mtimeMs,
    };
  }

  readSession(session: SessionSummary): SessionPayload {
    const transcriptPath =
      session.transcriptPath ??
      path.join(session.sessionDir, `${session.sessionId}.jsonl`);
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
