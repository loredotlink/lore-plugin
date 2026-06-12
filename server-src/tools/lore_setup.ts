/**
 * MCP tool: `lore_setup`.
 *
 * Entry point for the Lore setup / capture-status flow. Takes no required
 * arguments so the agent can call it to discover the current state without
 * knowing anything about prior interactions.
 *
 * Behaviour:
 *   - `consent ∈ {unconsented, declined}` → surface the consent panel so the
 *     user can enable background capture or skip.
 *   - `consent ∈ {consented, installed, idle, capturing}` → surface a status
 *     description of the current capture state with instructions for changing
 *     it.
 *
 * The handler delegates entirely to `buildConsentSurface` and
 * `buildSetupStatus` from `consentSurface.ts` and never re-implements their
 * logic.
 *
 * This tool is exempt from the consent gate (see `CONSENT_GATE_EXEMPT` in
 * `index.ts`) so it stays callable at any consent state — the agent can
 * always surface the consent prompt or capture status.
 */

import { execFile } from 'node:child_process';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  buildConsentSurface,
  buildSetupStatus,
} from '../lib/consentSurface.js';
import { readPluginState, writePluginState, type ConsentState } from '../lib/pluginState.js';
import type { ToolDefinition, ToolDispatchOpts } from '../lib/tool.js';
import {
  allowlistHasIncludeRules,
  readCaptureAllowlist,
  type AllowlistResult,
} from '../lib/uploadAllowlist.js';

type CliStatusReport = {
  health?: unknown;
  healthy?: unknown;
  enabled?: unknown;
  running?: unknown;
  status?: { state?: unknown };
};

type CliCommandResult = { status: number | null; stdout: string; stderr: string };

type BackgroundCaptureStatusResult =
  | {
      ok: true;
      consent: Extract<ConsentState, 'installed' | 'idle' | 'capturing'>;
      report: CliStatusReport;
      warning?: string;
    }
  | { ok: false; message: string };

type LoreSetupOpts = {
  home?: string;
  readBackgroundCaptureStatus?: () => Promise<BackgroundCaptureStatusResult>;
  readAllowlist?: () => Promise<AllowlistResult>;
};

/**
 * Core setup handler, separated from the tool definition so tests can
 * inject a `home` override for the plugin-state directory without
 * touching `os.homedir()`.
 */
export async function runLoreSetup(
  _args: Record<string, never>,
  opts: LoreSetupOpts = {},
): Promise<CallToolResult> {
  const state = await readPluginState(opts.home);

  if (state.consent === 'unconsented' || state.consent === 'declined') {
    return buildConsentSurface({
      macSupported: process.platform === 'darwin',
      consent: state.consent,
    });
  }

  if (state.consent === 'installed' || state.consent === 'idle' || state.consent === 'capturing') {
    const status = await (opts.readBackgroundCaptureStatus ?? readBackgroundCaptureStatus)();
    if (status.ok) {
      // The daemon's `status.state` distinguishes "running" (mid-upload) from
      // "idle" (up, but between sync cycles). That runtime cycle is NOT the
      // idle/capturing distinction we surface — what matters is whether
      // capture is *armed*: an allowlist with include rules. When the daemon
      // is up, derive idle vs capturing from the allowlist so a between-cycles
      // "idle" report never reverts a configured "capturing" state (and the
      // idle copy never claims the allowlist is empty when it isn't). The
      // daemon's true runtime stays visible in the appended status lines.
      const consent = await reconcileConsentWithAllowlist(
        status.consent,
        opts.readAllowlist ?? readCaptureAllowlist,
      );
      if (consent !== state.consent) {
        await writePluginState({ ...state, consent }, opts.home);
      }
      const result = appendCliStatus(buildSetupStatus(consent), status.report);
      return status.warning ? appendCliStatusWarning(result, status.warning) : result;
    }
    return appendCliStatusWarning(buildSetupStatus(state.consent), status.message);
  }

  return buildSetupStatus(state.consent);
}

export const loreSetupTool: ToolDefinition = {
  name: 'lore_setup',
  description:
    'Check or configure the Lore background session capture setup. ' +
    'Call with no arguments to see the current state and available actions. ' +
    'If capture is not yet configured, returns a consent panel to enable or skip. ' +
    'If already configured, returns the current capture status and how to change it.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  handler: async (args: unknown, opts?: ToolDispatchOpts): Promise<unknown> => {
    return runLoreSetup(args as Record<string, never>, { home: opts?.home });
  },
};

export async function readBackgroundCaptureStatus(
  opts: { runCommand?: (args: string[]) => Promise<CliCommandResult> } = {},
): Promise<BackgroundCaptureStatusResult> {
  const result = await (opts.runCommand ?? runLoreCli)(['status', '--json']);
  let report: CliStatusReport;
  try {
    report = JSON.parse(result.stdout) as CliStatusReport;
  } catch (error) {
    if (result.status !== 0) {
      return { ok: false, message: commandError(result) };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `invalid JSON from lore status --json: ${message}` };
  }
  return {
    ok: true,
    consent: consentFromStatusReport(report),
    report,
    ...(result.status === 0 ? {} : { warning: commandError(result) }),
  };
}

function runLoreCli(args: string[]): Promise<CliCommandResult> {
  return new Promise((resolve) => {
    execFile('lore', args, { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 5000 }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      resolve({
        status: typeof code === 'number' ? code : error ? null : 0,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
      });
    });
  });
}

function consentFromStatusReport(
  report: CliStatusReport,
): Extract<ConsentState, 'installed' | 'idle' | 'capturing'> {
  if (report.status?.state === 'running') return 'capturing';
  if (report.status?.state === 'idle') return 'idle';
  return 'installed';
}

/**
 * Resolve the displayed consent state from the daemon-derived state and the
 * configured allowlist.
 *
 * `installed` means the daemon is not actively up (state was neither
 * `running` nor `idle`) — capture is not running regardless of the
 * allowlist, so it is left as-is. When the daemon IS up (daemon-derived
 * state is `idle` or `capturing`), the meaningful distinction is whether
 * capture is armed: a non-empty include allowlist → `capturing`, an empty
 * one → `idle`. This keeps `lore_setup` and `lore_configure` agreeing on
 * what idle vs capturing means. The allowlist read is best-effort: if it
 * fails, the daemon-derived state is kept.
 */
async function reconcileConsentWithAllowlist(
  daemonConsent: Extract<ConsentState, 'installed' | 'idle' | 'capturing'>,
  readAllowlist: () => Promise<AllowlistResult>,
): Promise<Extract<ConsentState, 'installed' | 'idle' | 'capturing'>> {
  if (daemonConsent === 'installed') return daemonConsent;
  const allowlist = await readAllowlist();
  if (!allowlist.ok) return daemonConsent;
  return allowlistHasIncludeRules(allowlist.document) ? 'capturing' : 'idle';
}

function appendCliStatus(result: CallToolResult, report: CliStatusReport): CallToolResult {
  return appendText(
    result,
    [
      '',
      `CLI daemon reports: ${String(report.health ?? 'unknown')}`,
      `Enabled: ${String(report.enabled ?? 'unknown')}`,
      `Running: ${String(report.running ?? 'unknown')}`,
      `Healthy: ${String(report.healthy ?? 'unknown')}`,
    ].join('\n'),
  );
}

function appendCliStatusWarning(result: CallToolResult, message: string): CallToolResult {
  return appendText(result, `\nCould not refresh CLI daemon status: ${message}`);
}

function appendText(result: CallToolResult, suffix: string): CallToolResult {
  const content = result.content.map((block) => {
    if (block.type !== 'text') return block;
    return { ...block, text: `${block.text}${suffix}` };
  });
  return { ...result, content };
}

function commandError(result: { status: number | null; stdout: string; stderr: string }): string {
  return (result.stderr || result.stdout || `exit status ${result.status ?? 'unknown'}`).trim();
}
