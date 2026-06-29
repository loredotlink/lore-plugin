/**
 * Consent surface renderer for the Lore background-agent opt-in flow.
 *
 * Exports pure functions — no filesystem, network, or state access:
 *
 *   `buildConsentSurface(opts)` — returns a text-only `CallToolResult`
 *   describing the background-capture decision. The text block IS the
 *   surface; `structuredContent: { consent, macSupported }` is preserved
 *   so a future iframe surface can layer back on without a schema churn.
 *   No `{ type: 'resource' }` block, no `_meta` — see ADR-0007 (the target
 *   host does not render MCP Apps iframes today; the always-on text
 *   fallback ADR-0006 specified is now the only surface).
 *
 *   `buildAllowlistResult(opts)` — returns the text-only `CallToolResult`
 *   shown after `lore_configure` writes the allowlist.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ConsentState } from './pluginState.js';
import type { AllowlistDocument } from './uploadAllowlist.js';

/**
 * One-line disclosure naming the persistent background helper and the
 * interim trust controls. Shared across the supported/declined variants
 * of the consent text.
 *
 * Interim-trust honesty (plan Task 7): the controls today are the
 * multi-dimensional allowlist ("the repos, directories, or skills you
 * choose") plus the never-public default. Local secret scrubbing is NOT
 * yet shipped (Phase 2), so this copy must not claim it.
 */
const DISCLOSURE =
  'Lore can run a persistent background helper that watches the repos, ' +
  'directories, or skills you choose and uploads new matching sessions. ' +
  'Captured sessions are never public by default — they stay visible only ' +
  'to you (or your workspace).';

/** The literal enable/skip instruction block (only on supported platforms). */
const ENABLE_SKIP_INSTRUCTIONS =
  'To enable, call `lore_consent({ approve: true })`. ' +
  'To skip for now, call `lore_consent({ approve: false })`.';

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Build the consent surface: a text-only `CallToolResult` plus
 * `structuredContent: { consent, macSupported }`.
 *
 * Variants:
 *   - `macSupported: true` — disclosure + enable/skip instructions + status.
 *   - `macSupported: false` — states the background agent is unavailable on
 *     this platform; offers ONLY the skip instruction (never `approve: true`);
 *     does not promise capture.
 *   - `consent: 'declined'` — same shape; copy reflects re-opening the decision.
 */
export function buildConsentSurface(opts: {
  macSupported: boolean;
  consent: ConsentState;
}): CallToolResult {
  const { macSupported, consent } = opts;

  let text: string;

  if (!macSupported) {
    text = [
      'Lore Background Capture — Platform Unavailable',
      '',
      'The background session capture agent is not available on this ' +
        'platform today. Manual sharing and reads still work as usual.',
      '',
      'To skip for now, call `lore_consent({ approve: false })`.',
      '',
      'Status: background agent unavailable on this platform; manual sharing only.',
    ].join('\n');
  } else if (consent === 'declined') {
    text = [
      'Lore Background Capture — Re-opening the decision',
      '',
      DISCLOSURE,
      '',
      ENABLE_SKIP_INSTRUCTIONS,
      '',
      'Status: previously declined; re-opening the decision.',
    ].join('\n');
  } else {
    text = [
      'Lore Background Capture — Consent',
      '',
      DISCLOSURE,
      '',
      ENABLE_SKIP_INSTRUCTIONS,
      '',
      'Status: awaiting your decision (unconsented).',
    ].join('\n');
  }

  return {
    content: [{ type: 'text', text }],
    structuredContent: { consent, macSupported },
  };
}

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
