import fs from 'node:fs';
import {
  TRANSCRIPT_FILENAME_CANDIDATES,
  coworkSessionsRoot,
  findCoworkLocalSubdir,
  findCoworkTranscriptFile,
  listCoworkArtifactFiles,
  listCoworkSessions,
} from '@lore/transcript-locate';
import { nonBlank, type SessionPayload, type SessionSource, type SessionSummary } from './index.js';

export type CoworkSourceOptions = {
  /** Override the sessions root. Defaults to `coworkSessionsRoot()`. */
  sessionsRoot?: string;
  /** Override `os.homedir()` for tests when `sessionsRoot` isn't set. */
  home?: string;
};

export class CoworkSource implements SessionSource {
  readonly runtime = 'cowork' as const;
  private readonly sessionsRoot: string;

  constructor(opts: CoworkSourceOptions = {}) {
    this.sessionsRoot = opts.sessionsRoot ?? coworkSessionsRoot(opts.home);
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
    return listCoworkSessions(this.sessionsRoot);
  }

  findById(sessionId: string): SessionSummary {
    const match = this.listSessions().find((s) => s.sessionId === sessionId);
    if (!match) {
      throw new Error(`session not found: ${sessionId}`);
    }
    return match;
  }

  readSession(session: SessionSummary): SessionPayload {
    const localDir = findCoworkLocalSubdir(session.sessionDir);
    if (!localDir) {
      throw new Error(
        `Session ${session.sessionDir} has no local_* subdirectory — is this a Cowork session?`,
      );
    }
    const transcriptPath = findCoworkTranscriptFile(localDir);
    if (!transcriptPath) {
      throw new Error(
        `Session ${session.sessionDir} has no transcript file under ${localDir} ` +
          `(looked for ${TRANSCRIPT_FILENAME_CANDIDATES.join(', ')})`,
      );
    }
    return {
      sessionId: session.sessionId,
      accountId: session.accountId,
      orgId: session.orgId,
      transcriptPath,
      transcript: fs.readFileSync(transcriptPath, 'utf8'),
      uploads: listCoworkArtifactFiles(localDir, 'uploads'),
      outputs: listCoworkArtifactFiles(localDir, 'outputs'),
    };
  }
}
