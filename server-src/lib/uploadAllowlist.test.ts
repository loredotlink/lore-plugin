/**
 * Tests for uploadAllowlist.ts — the plugin's client for the CLI's
 * `lore configure --json` / `--set` allowlist contract. The CLI runner
 * is injected so no real `lore` binary is shelled.
 */
import { describe, test, expect } from 'bun:test';
import {
  allowlistHasIncludeRules,
  commandResultFromExec,
  readCaptureAllowlist,
  writeCaptureAllowlist,
  type AllowlistDocument,
  type CommandResult,
  type LoreRunner,
} from './uploadAllowlist.js';

const emptyDocument: AllowlistDocument = {
  version: 1,
  uploadFilters: {
    include: { cwd: [], repo: [], skills: [] },
    exclude: { cwd: [], repo: [], skills: [] },
  },
};

function ok(stdout: string): CommandResult {
  return { status: 0, stdout, stderr: '' };
}

describe('readCaptureAllowlist', () => {
  test('parses a valid document from `lore configure --json`', async () => {
    const runLore: LoreRunner = async (args) => {
      expect(args).toEqual(['configure', '--json']);
      return ok(JSON.stringify(emptyDocument));
    };
    const result = await readCaptureAllowlist(runLore);
    expect(result).toEqual({ ok: true, document: emptyDocument });
  });

  test('reports the CLI error when the command exits non-zero', async () => {
    const runLore: LoreRunner = async () => ({
      status: 1,
      stdout: '',
      stderr: 'not logged in',
    });
    const result = await readCaptureAllowlist(runLore);
    expect(result).toEqual({ ok: false, message: 'not logged in' });
  });

  test('reports a parse failure on non-JSON stdout', async () => {
    const runLore: LoreRunner = async () => ok('not json');
    const result = await readCaptureAllowlist(runLore);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/invalid JSON/);
  });

  test('rejects a document with the wrong shape', async () => {
    const runLore: LoreRunner = async () => ok(JSON.stringify({ version: 2 }));
    const result = await readCaptureAllowlist(runLore);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/unexpected document/);
  });
});

describe('writeCaptureAllowlist', () => {
  test('sends `configure --json --set <doc>` and parses the echoed result', async () => {
    const document: AllowlistDocument = {
      version: 1,
      uploadFilters: {
        include: { cwd: [], repo: ['owner/repo'], skills: [] },
        exclude: { cwd: [], repo: [], skills: [] },
      },
    };
    let sent: string[] | undefined;
    const runLore: LoreRunner = async (args) => {
      sent = args;
      return ok(JSON.stringify(document));
    };
    const result = await writeCaptureAllowlist(document, runLore);
    expect(sent?.slice(0, 3)).toEqual(['configure', '--json', '--set']);
    expect(JSON.parse(sent?.[3] ?? '')).toEqual(document);
    expect(result).toEqual({ ok: true, document });
  });

  test('reports the CLI error when the write fails', async () => {
    const runLore: LoreRunner = async () => ({
      status: 1,
      stdout: '',
      stderr: 'invalid repo filter',
    });
    const result = await writeCaptureAllowlist(emptyDocument, runLore);
    expect(result).toEqual({ ok: false, message: 'invalid repo filter' });
  });
});

describe('commandResultFromExec', () => {
  test('preserves a spawn ENOENT message so a missing CLI is detectable', () => {
    const err = Object.assign(new Error('spawn lore ENOENT'), { code: 'ENOENT' });
    const result = commandResultFromExec(err, '', '');
    expect(result.status).toBeNull();
    // The missing-CLI detector in lore_configure greps for /ENOENT/ etc.
    expect(result.stderr).toMatch(/ENOENT/);
  });

  test('uses the numeric exit code and stderr when the command actually ran', () => {
    const err = Object.assign(new Error('exited'), { code: 1 });
    const result = commandResultFromExec(err, 'partial', 'boom');
    expect(result).toEqual({ status: 1, stdout: 'partial', stderr: 'boom' });
  });

  test('clean success maps to status 0 with empty stderr', () => {
    const result = commandResultFromExec(null, 'out', '');
    expect(result).toEqual({ status: 0, stdout: 'out', stderr: '' });
  });
});

describe('allowlistHasIncludeRules', () => {
  test('false for an empty allowlist', () => {
    expect(allowlistHasIncludeRules(emptyDocument)).toBe(false);
  });

  test('true when any include dimension is non-empty', () => {
    for (const include of [
      { cwd: ['/x'], repo: [], skills: [] },
      { cwd: [], repo: ['o/r'], skills: [] },
      { cwd: [], repo: [], skills: ['s'] },
    ]) {
      expect(
        allowlistHasIncludeRules({
          version: 1,
          uploadFilters: { include, exclude: emptyDocument.uploadFilters.exclude },
        }),
      ).toBe(true);
    }
  });

  test('exclude-only rules do not count as include rules', () => {
    expect(
      allowlistHasIncludeRules({
        version: 1,
        uploadFilters: {
          include: { cwd: [], repo: [], skills: [] },
          exclude: { cwd: [], repo: ['o/r'], skills: [] },
        },
      }),
    ).toBe(false);
  });
});
