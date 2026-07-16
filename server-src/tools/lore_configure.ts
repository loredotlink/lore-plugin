/**
 * MCP tool: `lore_configure`.
 *
 * Chooses what the background agent captures by writing the CLI's
 * upload-filter allowlist (the repos, directories, or skills to watch),
 * then advances the plugin's consent state to `capturing` (when the
 * allowlist has include rules) or `idle` (when it is empty).
 *
 * Control-plane delegation (single capture engine — ADR-0002): this tool
 * does NOT touch `upload_filters.json` directly. It shells the CLI
 * (`lore configure --json` to read, `lore configure --set <json>` to
 * write) so the CLI remains the sole owner of capture config and
 * normalization. See `lib/uploadAllowlist.ts`.
 *
 * Requires the background agent to be installed first — only valid from
 * the `installed`, `idle`, or `capturing` states. From `consented` or
 * `declined`, or `unconsented`, it points the user back at
 * `lore_consent({ approve: true })`.
 */

import { buildAllowlistResult } from '../lib/consentSurface.js';
import {
  readPluginState,
  writePluginState,
  type ConsentState,
} from '../lib/pluginState.js';
import type { ToolDefinition, ToolDispatchOpts } from '../lib/tool.js';
import {
  allowlistHasIncludeRules,
  readCaptureAllowlist,
  writeCaptureAllowlist,
  type AllowlistDocument,
  type AllowlistResult,
  type LoreRunner,
} from '../lib/uploadAllowlist.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type LoreConfigureArgs = {
  repos?: string[];
  directories?: string[];
  skills?: string[];
  mode?: 'merge' | 'replace';
};

type LoreConfigureOpts = {
  home?: string;
  readAllowlist?: (runLore?: LoreRunner) => Promise<AllowlistResult>;
  writeAllowlist?: (
    document: AllowlistDocument,
    runLore?: LoreRunner,
  ) => Promise<AllowlistResult>;
};

export async function runLoreConfigure(
  args: LoreConfigureArgs,
  opts: LoreConfigureOpts = {},
): Promise<CallToolResult> {
  const state = await readPluginState(opts.home);

  // The control plane is only meaningful once the CLI agent is installed.
  if (
    state.consent !== 'installed' &&
    state.consent !== 'idle' &&
    state.consent !== 'capturing'
  ) {
    return notInstalledResult(state.consent);
  }

  const repos = normalizeStringArray(args.repos, 'repos');
  const directories = normalizeStringArray(args.directories, 'directories');
  const skills = normalizeStringArray(args.skills, 'skills');
  if ('error' in repos) return inputError(repos.error);
  if ('error' in directories) return inputError(directories.error);
  if ('error' in skills) return inputError(skills.error);

  const mode = args.mode ?? 'merge';
  if (mode !== 'merge' && mode !== 'replace') {
    return inputError(
      `mode must be "merge" or "replace", got ${JSON.stringify(args.mode)}`,
    );
  }

  const read = await (opts.readAllowlist ?? readCaptureAllowlist)();
  if (!read.ok) {
    return cliError('read your current allowlist', read.message);
  }

  const current = read.document.uploadFilters.include;
  const nextInclude =
    mode === 'replace'
      ? { cwd: directories.values, repo: repos.values, skills: skills.values }
      : {
          cwd: union(current.cwd, directories.values),
          repo: union(current.repo, repos.values),
          skills: union(current.skills, skills.values),
        };

  const nextDocument: AllowlistDocument = {
    version: 1,
    uploadFilters: {
      include: nextInclude,
      exclude: read.document.uploadFilters.exclude,
    },
  };

  const write = await (opts.writeAllowlist ?? writeCaptureAllowlist)(
    nextDocument,
  );
  if (!write.ok) {
    return cliError('update your allowlist', write.message);
  }

  // The CLI normalizes (lowercases repos, expands `~`, dedupes) on write
  // and echoes the canonical document back; reflect that, not our input.
  const consent: Extract<ConsentState, 'idle' | 'capturing'> =
    allowlistHasIncludeRules(write.document) ? 'capturing' : 'idle';
  if (consent !== state.consent) {
    await writePluginState({ ...state, consent }, opts.home);
  }

  return buildAllowlistResult({ consent, document: write.document });
}

export const loreConfigureTool: ToolDefinition = {
  name: 'lore_configure',
  description:
    'Choose what Lore background capture watches: the repos, directories, ' +
    'or skills to auto-capture. Pass any of `repos` (owner/name), ' +
    '`directories` (absolute paths), or `skills` (skill ids). ' +
    'Defaults to merging with the existing allowlist; pass `mode: "replace"` ' +
    'to overwrite it (replace with all-empty lists to stop capturing). ' +
    'Requires background capture to be enabled first via `lore_consent({ approve: true })`.',
  inputSchema: {
    type: 'object',
    properties: {
      repos: {
        type: 'array',
        items: { type: 'string' },
        description: 'Repositories to capture, as owner/name or a git remote URL.',
      },
      directories: {
        type: 'array',
        items: { type: 'string' },
        description: 'Absolute (or ~-relative) directories to capture sessions from.',
      },
      skills: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Skill identifiers to capture (matching sessions are captured from any directory).',
      },
      mode: {
        type: 'string',
        enum: ['merge', 'replace'],
        description:
          'merge (default) adds to the current allowlist; replace overwrites it.',
      },
    },
    additionalProperties: false,
  },
  handler: async (args: unknown, opts?: ToolDispatchOpts): Promise<unknown> => {
    return runLoreConfigure(args as LoreConfigureArgs, { home: opts?.home });
  },
};

function normalizeStringArray(
  value: unknown,
  field: string,
): { values: string[] } | { error: string } {
  if (value === undefined) return { values: [] };
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return { error: `${field} must be an array of strings` };
  }
  return { values: value as string[] };
}

function union(existing: string[], added: string[]): string[] {
  const seen = new Set(existing);
  const result = [...existing];
  for (const item of added) {
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

function notInstalledResult(consent: ConsentState): CallToolResult {
  const prefix =
    consent === 'consented'
      ? 'Lore is finishing background-capture setup.'
      : 'Lore background capture is not set up yet.';
  return {
    content: [
      {
        type: 'text',
        text:
          `${prefix} Call \`lore_consent({ approve: true })\` ` +
          `to install the background agent before choosing an allowlist.`,
      },
    ],
    structuredContent: { consent },
  };
}

function inputError(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: `Could not update the allowlist: ${message}.` }],
    isError: true,
  };
}

function cliError(action: string, message: string): CallToolResult {
  // Surface the CLI's own error to the agent so it can relay it. If the
  // failure looks like a missing CLI, fall back to the setup pointer.
  const text = /not found|ENOENT|command not found/i.test(message)
    ? `Lore could not ${action} because the background agent CLI is not available. ` +
      `Call \`lore_consent({ approve: true })\` to (re)install it.`
    : `Lore could not ${action}: ${message}`;
  return { content: [{ type: 'text', text }], isError: true };
}
