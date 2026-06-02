import { type ChildProcess, spawn } from 'node:child_process';
import os from 'node:os';

type ClipboardCmd = {
  name: string;
  args: string[];
};

// Pick the first clipboard tool that's executable on $PATH and pipe `text` to
// it. Clipboard failures are best-effort UX failures, not share failures, so
// callers get a boolean rather than an exception.
export async function copyToClipboard(
  text: string,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 2000;
  for (const candidate of clipboardCandidates()) {
    const ok = await runClipboardCandidate(candidate, text, timeoutMs);
    if (ok) return true;
  }
  return false;
}

function clipboardCandidates(): ClipboardCmd[] {
  switch (os.platform()) {
    case 'darwin':
      return [{ name: 'pbcopy', args: [] }];
    case 'linux':
      return [
        { name: 'wl-copy', args: [] },
        { name: 'xclip', args: ['-selection', 'clipboard'] },
        { name: 'xsel', args: ['--clipboard', '--input'] },
      ];
    case 'win32':
      return [{ name: 'clip.exe', args: [] }];
    default:
      return [];
  }
}

async function runClipboardCandidate(
  candidate: ClipboardCmd,
  text: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(candidate.name, candidate.args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(false);
    }, timeoutMs);

    child.on('error', () => {
      clearTimeout(timer);
      settle(false);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      settle(code === 0);
    });

    child.stdin?.on('error', () => {
      // ignore — close handler reports the outcome
    });
    child.stdin?.end(text);
  });
}
