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

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  buildConsentSurface,
  buildSetupStatus,
} from '../lib/consentSurface.js';
import { readPluginState } from '../lib/pluginState.js';
import type { ToolDefinition } from '../lib/tool.js';

/**
 * Core setup handler, separated from the tool definition so tests can
 * inject a `home` override for the plugin-state directory without
 * touching `os.homedir()`.
 */
export async function runLoreSetup(
  _args: Record<string, never>,
  opts: { home?: string } = {},
): Promise<CallToolResult> {
  const state = await readPluginState(opts.home);

  if (state.consent === 'unconsented' || state.consent === 'declined') {
    return buildConsentSurface({
      macSupported: process.platform === 'darwin',
      consent: state.consent,
    });
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
  handler: async (args: unknown): Promise<unknown> => {
    return runLoreSetup(args as Record<string, never>);
  },
};
