/**
 * MCP tool: `lore_consent`.
 *
 * Records the user's consent decision for automatic session capture and
 * initiates (or cancels) the background agent install process.
 *
 * `approve === true`  → records consent, installs/enables the CLI-backed
 *   background agent on macOS, then advances consent to the installed/idle/
 *   capturing state reported by the CLI.
 *
 * `approve === false` → sets consent to 'declined'. This same path also
 *   serves the "disable" flow from a `consented` state. Returns a
 *   confirmation that manual share/reads keep working and `/lore:setup`
 *   can re-enable later.
 *
 * Constraints:
 *   - Consent is written before any installer shell-out.
 *   - Existing installed/idle/capturing states are not downgraded by a
 *     later `approve: true` retry.
 *   - Schema validation (`approve` must be a boolean) is enforced by the
 *     dispatcher's `validateAgainstSchema` in `index.ts` before the
 *     handler is invoked.
 */

import { execFile } from 'node:child_process';

import type { ToolDefinition, ToolDispatchOpts } from '../lib/tool.js';
import { readPluginState, writePluginState, type ConsentState } from '../lib/pluginState.js';

export type LoreConsentArgs = {
  approve: boolean;
};

export type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export type ConsentInstallResult =
  | {
      ok: true;
      consent: Extract<ConsentState, 'installed' | 'idle' | 'capturing'>;
      message: string;
    }
  | {
      ok: false;
      reason: 'unsupported_platform' | 'install_failed';
      message: string;
    };

type DisableResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

type LoreConsentOpts = {
  home?: string;
  platform?: NodeJS.Platform | string;
  installBackgroundAgent?: (opts: { home?: string }) => Promise<ConsentInstallResult>;
  disableBackgroundAgent?: (opts: { home?: string }) => Promise<DisableResult>;
};

/**
 * Install/enable the CLI-backed background agent.
 *
 * Uses an existing `lore` command when present; otherwise falls back to
 * `npm install -g @tanagram/lore`. We intentionally do not invent a binary
 * download fallback here because no release artifact + checksum contract
 * exists yet. After enabling, `lore status --json` maps the CLI's runtime
 * state into the plugin consent state.
 */
export async function beginBackgroundAgentInstall(
  opts: {
    home?: string;
    platform?: NodeJS.Platform | string;
    runCommand?: (cmd: string, args: string[]) => Promise<CommandResult>;
  } = {},
): Promise<ConsentInstallResult> {
  const platform = opts.platform ?? process.platform;
  const runCommand = opts.runCommand ?? defaultRunCommand;
  if (platform !== 'darwin') {
    return {
      ok: false,
      reason: 'unsupported_platform',
      message: 'Automatic background capture is currently available on macOS only.',
    };
  }

  const existingLore = await runCommand('lore', ['--version']);
  if (existingLore.status !== 0) {
    const npmAvailable = await runCommand('npm', ['--version']);
    if (npmAvailable.status !== 0) {
      return {
        ok: false,
        reason: 'install_failed',
        message:
          'Could not install Lore automatically because npm was not found. Install Node.js/npm, then run `/lore:setup` again.',
      };
    }
    const install = await runCommand('npm', ['install', '-g', '@tanagram/lore']);
    if (install.status !== 0) {
      return {
        ok: false,
        reason: 'install_failed',
        message: `Could not install Lore CLI with npm: ${commandError(install)}`,
      };
    }
  }

  const enable = await runCommand('lore', ['enable']);
  if (enable.status !== 0) {
    return {
      ok: false,
      reason: 'install_failed',
      message: `Lore CLI installed, but enabling background capture failed: ${commandError(enable)}`,
    };
  }

  const status = await runCommand('lore', ['status', '--json']);
  const consent = consentFromStatusJson(status.stdout);
  return {
    ok: true,
    consent,
    message: messageForConsent(consent),
  };
}

/**
 * Core consent handler, separated from the tool definition so tests can
 * inject a `home` override for the plugin-state directory without
 * touching `os.homedir()`.
 */
export async function runLoreConsent(
  args: LoreConsentArgs,
  opts: LoreConsentOpts = {},
): Promise<string> {
  const state = await readPluginState(opts.home);

  if (args.approve) {
    if (state.consent === 'installed' || state.consent === 'idle' || state.consent === 'capturing') {
      return `Lore background capture is already ${state.consent}. Use \`lore_consent\` with \`approve: false\` to stop.`;
    }
    const platform = opts.platform ?? process.platform;
    if (platform !== 'darwin') {
      return (
        'Automatic background capture is unavailable on this platform today. ' +
        'Manual `/lore:share` and `/lore:read` commands continue to work as usual.'
      );
    }
    await writePluginState({ ...state, consent: 'consented' }, opts.home);
    const install = await (opts.installBackgroundAgent ?? beginBackgroundAgentInstall)({
      home: opts.home,
    });
    if (!install.ok) {
      return `Consent recorded, but Lore could not finish background capture setup. ${install.message}`;
    }
    await writePluginState({ ...state, consent: install.consent }, opts.home);
    return (
      `Consent recorded. Background capture setup complete: ${install.message} ` +
      'Use `lore_consent` with `approve: false` at any time to stop.'
    );
  } else {
    if (state.consent === 'installed' || state.consent === 'idle' || state.consent === 'capturing') {
      const disable = await (opts.disableBackgroundAgent ?? disableBackgroundAgent)({
        home: opts.home,
      });
      if (!disable.ok) {
        return `Lore could not disable background capture. ${disable.message}`;
      }
      await writePluginState({ ...state, consent: 'declined' }, opts.home);
      return (
        `Consent declined. ${disable.message} ` +
        'Manual `/lore:share` and `/lore:read` commands continue to work as usual. ' +
        'Run `/lore:setup` to re-enable automatic capture later.'
      );
    }
    await writePluginState({ ...state, consent: 'declined' }, opts.home);
    return (
      'Consent declined. Manual `/lore:share` and `/lore:read` commands continue to work as usual. ' +
      'Run `/lore:setup` to re-enable automatic capture later.'
    );
  }
}

export const loreConsentTool: ToolDefinition = {
  name: 'lore_consent',
  description:
    'Record the user\'s consent decision for automatic Lore session capture. ' +
    'Pass `approve: true` to enable background capture (consent state → "consented"); ' +
    'pass `approve: false` to decline or disable it (consent state → "declined"). ' +
    'Manual share and read commands are unaffected by either choice.',
  inputSchema: {
    type: 'object',
    properties: {
      approve: {
        type: 'boolean',
        description: 'true to consent to automatic capture; false to decline or disable.',
      },
    },
    required: ['approve'],
    additionalProperties: false,
  },
  handler: async (args: unknown, opts?: ToolDispatchOpts): Promise<unknown> => {
    // The dispatcher validates `approve` exists and is a boolean before
    // reaching here, so the cast is safe. Forward `opts.home` so tests
    // can isolate plugin-state reads/writes in a tmp directory.
    return runLoreConsent(args as LoreConsentArgs, { home: opts?.home, platform: opts?.platform });
  },
};

async function disableBackgroundAgent(
  opts: {
    home?: string;
    runCommand?: (cmd: string, args: string[]) => Promise<CommandResult>;
  } = {},
): Promise<DisableResult> {
  const runCommand = opts.runCommand ?? defaultRunCommand;
  const result = await runCommand('lore', ['disable']);
  if (result.status !== 0) {
    return { ok: false, message: commandError(result) };
  }
  return { ok: true, message: 'Lore background capture has been disabled.' };
}

function defaultRunCommand(cmd: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      resolve({
        status: typeof code === 'number'
          ? code
          : error
            ? null
            : 0,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
      });
    });
  });
}

function consentFromStatusJson(stdout: string): Extract<ConsentState, 'installed' | 'idle' | 'capturing'> {
  try {
    const parsed = JSON.parse(stdout) as { status?: { state?: unknown } };
    if (parsed.status?.state === 'running') return 'capturing';
    if (parsed.status?.state === 'idle') return 'idle';
  } catch {
    // Status is best-effort after a successful enable; fall through to installed.
  }
  return 'installed';
}

function messageForConsent(consent: Extract<ConsentState, 'installed' | 'idle' | 'capturing'>): string {
  switch (consent) {
    case 'capturing':
      return 'Lore background capture is running.';
    case 'idle':
      return 'Lore background capture is idle.';
    case 'installed':
      return 'Lore background agent is installed.';
  }
}

function commandError(result: CommandResult): string {
  return (result.stderr || result.stdout || `exit status ${result.status ?? 'unknown'}`).trim();
}
