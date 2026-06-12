/**
 * Plugin-side client for the CLI's upload-filter allowlist contract
 * (`lore configure --json` to read, `lore configure --set <json>` to
 * replace). The CLI owns the config file and all normalization
 * (repo → lowercase owner/name, `~`-expansion, dedupe + sort) — the
 * plugin never writes `upload_filters.json` itself (single capture
 * engine, ADR-0002). Callers round-trip the document: get → modify
 * include sets → set.
 *
 * `--set` accepts exactly what `--json` prints, so the document read
 * here can be edited and written back without re-implementing the
 * CLI's normalization rules.
 */

import { execFile } from 'node:child_process';
import { z } from 'zod';

export type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

/** Runs the `lore` CLI with the given args. Injectable for tests. */
export type LoreRunner = (args: string[]) => Promise<CommandResult>;

const FilterSetSchema = z.object({
  cwd: z.array(z.string()).default([]),
  repo: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
});

export const AllowlistDocumentSchema = z.object({
  version: z.literal(1),
  uploadFilters: z.object({
    include: FilterSetSchema,
    exclude: FilterSetSchema,
  }),
});

export type AllowlistDocument = z.infer<typeof AllowlistDocumentSchema>;

export type AllowlistResult =
  | { ok: true; document: AllowlistDocument }
  | { ok: false; message: string };

export async function readCaptureAllowlist(
  runLore: LoreRunner = defaultLoreRunner,
): Promise<AllowlistResult> {
  const result = await runLore(['configure', '--json']);
  if (result.status !== 0) {
    return { ok: false, message: commandError(result) };
  }
  return parseDocument(result.stdout, 'lore configure --json');
}

export async function writeCaptureAllowlist(
  document: AllowlistDocument,
  runLore: LoreRunner = defaultLoreRunner,
): Promise<AllowlistResult> {
  const result = await runLore([
    'configure',
    '--json',
    '--set',
    JSON.stringify(document),
  ]);
  if (result.status !== 0) {
    return { ok: false, message: commandError(result) };
  }
  return parseDocument(result.stdout, 'lore configure --set');
}

export function allowlistHasIncludeRules(document: AllowlistDocument): boolean {
  const { cwd, repo, skills } = document.uploadFilters.include;
  return cwd.length > 0 || repo.length > 0 || skills.length > 0;
}

function parseDocument(stdout: string, source: string): AllowlistResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `invalid JSON from ${source}: ${message}` };
  }
  const result = AllowlistDocumentSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      message: `unexpected document from ${source}: ${result.error.message}`,
    };
  }
  return { ok: true, document: result.data };
}

function defaultLoreRunner(args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      'lore',
      args,
      { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 5000 },
      (error, stdout, stderr) => {
        resolve(commandResultFromExec(error, stdout, stderr));
      },
    );
  });
}

/**
 * Map an `execFile` callback result into a `CommandResult`.
 *
 * `execFile` reports a **spawn failure** (e.g. `ENOENT` when `lore` is not
 * on `PATH`) via `error` with a non-numeric `code` and empty stderr. We
 * preserve the error message (which contains `ENOENT`) so callers can
 * detect a missing CLI and surface reinstall guidance, instead of dropping
 * it to a generic "exit status unknown".
 */
export function commandResultFromExec(
  error: (Error & { code?: unknown }) | null,
  stdout: unknown,
  stderr: unknown,
): CommandResult {
  const code = error?.code;
  const stderrText = typeof stderr === 'string' ? stderr : '';
  return {
    status: typeof code === 'number' ? code : error ? null : 0,
    stdout: typeof stdout === 'string' ? stdout : '',
    stderr: error && !stderrText ? (error.message ?? String(error)) : stderrText,
  };
}

function commandError(result: CommandResult): string {
  return (
    result.stderr ||
    result.stdout ||
    `exit status ${result.status ?? 'unknown'}`
  ).trim();
}
