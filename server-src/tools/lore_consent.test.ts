import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runLoreConsent,
  loreConsentTool,
  beginBackgroundAgentInstall,
  type ConsentInstallResult,
  type CommandResult,
} from './lore_consent';
import type { ConsentState } from '../lib/pluginState';
import { readPluginState, writePluginState } from '../lib/pluginState';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-consent-test-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function successfulInstall(
  consent: Extract<ConsentState, 'installed' | 'idle' | 'capturing'> = 'installed',
) {
  return async (): Promise<ConsentInstallResult> => ({
    ok: true,
    consent,
    message: 'installed',
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let home: string;

beforeEach(() => {
  home = makeTmpHome();
});

afterEach(() => {
  rmrf(home);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runLoreConsent', () => {
  test('approve: true on macOS → installs background agent and persists installer consent state', async () => {
    let installCalls = 0;
    const result = await runLoreConsent(
      { approve: true },
      {
        home,
        platform: 'darwin',
        installBackgroundAgent: async () => {
          installCalls++;
          return { ok: true, consent: 'idle', message: 'watcher idle' };
        },
      },
    );

    const state = await readPluginState(home);
    expect(installCalls).toBe(1);
    expect(state.consent).toBe('idle');
    expect(result.toLowerCase()).toContain('watcher idle');
  });

  test('approve: false → persists consent = "declined"', async () => {
    await runLoreConsent({ approve: false }, { home });
    const state = await readPluginState(home);
    expect(state.consent).toBe('declined');
  });

  test('approve: true → returns confirmation string mentioning capture setup', async () => {
    const result = await runLoreConsent(
      { approve: true },
      { home, platform: 'darwin', installBackgroundAgent: successfulInstall() },
    );
    expect(typeof result).toBe('string');
    expect(result.toLowerCase()).toContain('capture');
  });

  test('approve: false → returns confirmation string mentioning manual share/read and re-enable', async () => {
    const result = await runLoreConsent({ approve: false }, { home });
    expect(typeof result).toBe('string');
    // mentions that manual operations still work
    expect(result.toLowerCase()).toMatch(/share|read/);
    // mentions re-enable path
    expect(result.toLowerCase()).toMatch(/re.?enable|setup/);
  });

  test('consent survives reload: approve true then re-read from disk', async () => {
    await runLoreConsent(
      { approve: true },
      { home, platform: 'darwin', installBackgroundAgent: successfulInstall() },
    );
    // Simulate a fresh read (no in-memory cache involved)
    const state = await readPluginState(home);
    expect(state.consent).toBe('installed');
  });

  test('consent survives reload: approve false then re-read from disk', async () => {
    await runLoreConsent({ approve: false }, { home });
    const state = await readPluginState(home);
    expect(state.consent).toBe('declined');
  });

  test('approve: true preserves existing share_count and watcher_prompt_dismissed', async () => {
    // Pre-seed state with non-default values.
    await writePluginState(
      { share_count: 7, watcher_prompt_dismissed: true, consent: 'unconsented' },
      home,
    );
    await runLoreConsent(
      { approve: true },
      { home, platform: 'darwin', installBackgroundAgent: successfulInstall() },
    );
    const state = await readPluginState(home);
    expect(state.consent).toBe('installed');
    expect(state.share_count).toBe(7);
    expect(state.watcher_prompt_dismissed).toBe(true);
  });

  test('approve: false preserves existing share_count', async () => {
    await writePluginState(
      { share_count: 3, watcher_prompt_dismissed: false, consent: 'consented' },
      home,
    );
    await runLoreConsent({ approve: false }, { home });
    const state = await readPluginState(home);
    expect(state.consent).toBe('declined');
    expect(state.share_count).toBe(3);
  });

  test('decline from consented state ("disable" flow) → consent = "declined"', async () => {
    await writePluginState(
      { share_count: 0, watcher_prompt_dismissed: false, consent: 'consented' },
      home,
    );
    await runLoreConsent({ approve: false }, { home });
    const state = await readPluginState(home);
    expect(state.consent).toBe('declined');
  });

  test('approve: true on non-macOS does not record consent or install a no-op daemon', async () => {
    let installCalls = 0;
    const result = await runLoreConsent(
      { approve: true },
      {
        home,
        platform: 'linux',
        installBackgroundAgent: async () => {
          installCalls++;
          return { ok: true, consent: 'installed', message: 'should not run' };
        },
      },
    );

    const state = await readPluginState(home);
    expect(installCalls).toBe(0);
    expect(state.consent).toBe('unconsented');
    expect(result.toLowerCase()).toContain('unavailable');
  });

  test('approve: true is idempotent once installed and does not downgrade or reinstall', async () => {
    await writePluginState(
      { share_count: 0, watcher_prompt_dismissed: false, consent: 'capturing' },
      home,
    );
    let installCalls = 0;

    await runLoreConsent(
      { approve: true },
      {
        home,
        platform: 'darwin',
        installBackgroundAgent: async () => {
          installCalls++;
          return { ok: true, consent: 'installed', message: 'should not run' };
        },
      },
    );

    const state = await readPluginState(home);
    expect(installCalls).toBe(0);
    expect(state.consent).toBe('capturing');
  });

  test('approve: false from installed state disables the background agent before persisting declined', async () => {
    await writePluginState(
      { share_count: 0, watcher_prompt_dismissed: false, consent: 'installed' },
      home,
    );
    let disableCalls = 0;

    const result = await runLoreConsent(
      { approve: false },
      {
        home,
        disableBackgroundAgent: async () => {
          disableCalls++;
          return { ok: true, message: 'disabled' };
        },
      },
    );

    const state = await readPluginState(home);
    expect(disableCalls).toBe(1);
    expect(state.consent).toBe('declined');
    expect(result.toLowerCase()).toContain('disabled');
  });
});

describe('loreConsentTool definition', () => {
  test('tool name is "lore_consent"', () => {
    expect(loreConsentTool.name).toBe('lore_consent');
  });

  test('inputSchema requires "approve" boolean', () => {
    expect(loreConsentTool.inputSchema.required).toContain('approve');
    expect(loreConsentTool.inputSchema.additionalProperties).toBe(false);
    const approveSchema = loreConsentTool.inputSchema.properties?.approve as Record<string, unknown>;
    expect(approveSchema?.type).toBe('boolean');
  });

  test('handler delegates to runLoreConsent via tmp home (integration smoke)', async () => {
    // The handler uses the real home directory but we can verify it returns
    // a string and does not throw when called with a valid arg via the
    // exported runLoreConsent directly.
    const result = await runLoreConsent({ approve: false }, { home });
    expect(typeof result).toBe('string');
  });
});

describe('beginBackgroundAgentInstall', () => {
  test('uses an existing lore CLI, enables launchd, and maps idle status', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runCommand = async (cmd: string, args: string[]): Promise<CommandResult> => {
      calls.push({ cmd, args });
      if (cmd === 'lore' && args[0] === '--version') return { status: 0, stdout: '1.2.3', stderr: '' };
      if (cmd === 'lore' && args[0] === 'enable') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'lore' && args.join(' ') === 'status --json') {
        return {
          status: 0,
          stdout: JSON.stringify({ status: { state: 'idle' } }),
          stderr: '',
        };
      }
      return { status: 1, stdout: '', stderr: 'unexpected' };
    };

    const result = await beginBackgroundAgentInstall({ platform: 'darwin', runCommand });

    expect(result).toEqual({ ok: true, consent: 'idle', message: 'Lore background capture is idle.' });
    expect(calls).toEqual([
      { cmd: 'lore', args: ['--version'] },
      { cmd: 'lore', args: ['enable'] },
      { cmd: 'lore', args: ['status', '--json'] },
    ]);
  });

  test('installs via npm when lore is not already available', async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runCommand = async (cmd: string, args: string[]): Promise<CommandResult> => {
      calls.push({ cmd, args });
      if (cmd === 'lore' && args[0] === '--version' && calls.length === 1) {
        return { status: 127, stdout: '', stderr: 'not found' };
      }
      if (cmd === 'npm' && args[0] === '--version') return { status: 0, stdout: '10.0.0', stderr: '' };
      if (cmd === 'npm' && args[0] === 'install') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'lore' && args[0] === 'enable') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'lore' && args.join(' ') === 'status --json') {
        return {
          status: 0,
          stdout: JSON.stringify({ status: { state: 'running' } }),
          stderr: '',
        };
      }
      return { status: 1, stdout: '', stderr: 'unexpected' };
    };

    const result = await beginBackgroundAgentInstall({ platform: 'darwin', runCommand });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.consent).toBe('capturing');
    expect(calls).toEqual([
      { cmd: 'lore', args: ['--version'] },
      { cmd: 'npm', args: ['--version'] },
      { cmd: 'npm', args: ['install', '-g', '@tanagram/lore'] },
      { cmd: 'lore', args: ['enable'] },
      { cmd: 'lore', args: ['status', '--json'] },
    ]);
  });

  test('returns unsupported without shelling out on non-macOS', async () => {
    let calls = 0;
    const result = await beginBackgroundAgentInstall({
      platform: 'linux',
      runCommand: async () => {
        calls++;
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    expect(calls).toBe(0);
    expect(result).toEqual({
      ok: false,
      reason: 'unsupported_platform',
      message: 'Automatic background capture is currently available on macOS only.',
    });
  });
});
