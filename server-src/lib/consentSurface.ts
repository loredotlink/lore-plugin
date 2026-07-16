/**
 * Result renderer for Lore background-capture configuration.
 *
 * Exports pure functions — no filesystem, network, or state access:
 *
 *   `buildAllowlistResult(opts)` — returns the text-only `CallToolResult`
 *   shown after `lore_configure` writes the allowlist.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ConsentState } from './pluginState.js';
import type { AllowlistDocument } from './uploadAllowlist.js';

/**
 * Build the result shown after `lore_configure` writes the allowlist.
 *
 * `consent` is the resulting plugin state: `capturing` when the allowlist
 * now has include rules, `idle` when it is empty. The copy is honest
 * about the interim trust controls (multi-dimensional allowlist +
 * never-public default) and does NOT claim local secret scrubbing, which
 * has not shipped yet (plan Task 7).
 *
 * Text-only (ADR-0007); `structuredContent` carries the resulting state
 * and the watched dimensions for a future iframe surface.
 */
export function buildAllowlistResult(opts: {
  consent: Extract<ConsentState, 'idle' | 'capturing'>;
  document: AllowlistDocument;
}): CallToolResult {
  const { consent, document } = opts;
  const include = document.uploadFilters.include;

  let text: string;
  if (consent === 'capturing') {
    text = [
      'Lore background capture: now watching your allowlist.',
      '',
      'Lore will automatically capture and upload new sessions that match ' +
        'the repos, directories, or skills you chose. Captured sessions are ' +
        'never public by default — they stay visible only to you (or your ' +
        'workspace).',
      '',
      ...describeWatched(include),
      '',
      "To change what's captured, call `lore_configure` again. To stop " +
        'entirely, call `lore_consent({ approve: false })`.',
    ].join('\n');
  } else {
    text = [
      'Lore background capture: idle — nothing selected.',
      '',
      'Your allowlist is now empty, so no sessions are being captured. ' +
        'Choose the repos, directories, or skills you want watched by ' +
        'calling `lore_configure` with at least one entry.',
    ].join('\n');
  }

  return {
    content: [{ type: 'text', text }],
    structuredContent: {
      consent,
      include: {
        cwd: include.cwd,
        repo: include.repo,
        skills: include.skills,
      },
    },
  };
}

/** Render the non-empty include dimensions as a short "Watching:" list. */
function describeWatched(include: AllowlistDocument['uploadFilters']['include']): string[] {
  const lines: string[] = ['Watching:'];
  if (include.repo.length > 0) lines.push(`- Repos: ${include.repo.join(', ')}`);
  if (include.cwd.length > 0) lines.push(`- Directories: ${include.cwd.join(', ')}`);
  if (include.skills.length > 0) lines.push(`- Skills: ${include.skills.join(', ')}`);
  return lines;
}
