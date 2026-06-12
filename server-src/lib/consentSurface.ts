/**
 * Consent surface renderer for the Lore background-agent opt-in flow.
 *
 * Exports two pure functions — no filesystem, network, or state access:
 *
 *   `buildConsentSurface(opts)` — returns a text-only `CallToolResult`
 *   describing the background-capture decision. The text block IS the
 *   surface; `structuredContent: { consent, macSupported }` is preserved
 *   so a future iframe surface can layer back on without a schema churn.
 *   No `{ type: 'resource' }` block, no `_meta` — see ADR-0007 (the target
 *   host does not render MCP Apps iframes today; the always-on text
 *   fallback ADR-0006 specified is now the only surface).
 *
 *   `buildSetupStatus(consent)` — returns a text-only `CallToolResult`
 *   describing the current consent state and how to change it.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ConsentState } from './pluginState.js';

/**
 * One-line disclosure naming the persistent background helper and the
 * local secret-scrubbing guarantee. Shared across the supported/declined
 * variants of the consent text.
 */
const DISCLOSURE =
  'Lore can run a persistent background helper that watches directories you ' +
  'choose and uploads new sessions; secrets are scrubbed locally before upload.';

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
 * Build a status-only result describing the current consent state and
 * how the user can change it. Text-only.
 */
export function buildSetupStatus(consent: ConsentState): CallToolResult {
  let text: string;

  switch (consent) {
    case 'unconsented':
      text =
        `Lore background capture: not yet configured.\n\n` +
        `To enable, call \`lore_consent({ approve: true })\`.\n` +
        `To skip, call \`lore_consent({ approve: false })\`.`;
      break;

    case 'consented':
      text =
        `Lore background capture: consent given.\n\n` +
        `The background agent will be installed on the next session.\n` +
        `To withdraw consent, call \`lore_consent({ approve: false })\`.`;
      break;

    case 'declined':
      text =
        `Lore background capture: declined / skipped.\n\n` +
        `You can re-enable at any time by calling \`lore_consent({ approve: true })\`.`;
      break;

    case 'installed':
      text =
        `Lore background capture: agent installed.\n\n` +
        `The watcher is installed but not yet active for a watched directory.\n` +
        `To disable, call \`lore_consent({ approve: false })\`.`;
      break;

    case 'idle':
      text =
        `Lore background capture: idle / paused.\n\n` +
        `The watcher is installed but is not currently active.\n` +
        `To disable, call \`lore_consent({ approve: false })\`.`;
      break;

    case 'capturing':
      text =
        `Lore background capture: active — currently capturing sessions.\n\n` +
        `Sessions are being watched and uploaded automatically.\n` +
        `To disable, call \`lore_consent({ approve: false })\`.`;
      break;

    default: {
      // Exhaustiveness guard — TypeScript will catch missing cases at compile
      // time; this branch exists for runtime safety.
      const _exhaustive: never = consent;
      text = `Lore background capture: unknown state (${_exhaustive}).`;
    }
  }

  return { content: [{ type: 'text', text }] };
}
