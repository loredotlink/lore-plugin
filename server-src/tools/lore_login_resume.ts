/**
 * MCP tool: `lore_login_resume`.
 *
 * Headless fallback for `lore_login`. When the auto-`open` step fails
 * (SSH, no DISPLAY, sandboxed runtime), `lore_login` surfaces the
 * `verification_uri` + `device_code`; the user visits the URL on any
 * device and the agent calls this tool with the surfaced `device_code`
 * to drive the poll loop to completion.
 *
 * Why a separate tool rather than a flag on `lore_login`:
 *   The two tools differ in their inputs (one takes nothing, one takes
 *   a `device_code`) and in their semantics (`lore_login` mints a new
 *   code; this tool resumes a pre-issued one). Modelling them as
 *   distinct tools lets the dispatcher's JSON-schema validator enforce
 *   the `device_code` requirement structurally, and lets the agent
 *   discover the fallback by name from `lore_login`'s description.
 *
 * Why defaults for `expires_in_seconds`/`interval_seconds`:
 *   The cloud's device-code response is the only place those numbers
 *   are issued. On resume, the agent doesn't have them — they were
 *   consumed inside `runLoreLogin` and never serialized back. We pick
 *   conservative defaults (600s cap, 5s interval) that match the
 *   server's current configuration; if the user happens to resume past
 *   the actual server-side expiry the next poll will return
 *   `expired_token` and we surface that cleanly.
 *
 * Why this file does not import `runLoreLogin`:
 *   `runLoreLogin` is the cold-start orchestrator and bundles the
 *   device-code mint + browser-open steps that resume must skip. The
 *   shared surface is `pollDeviceToken` from `lib/auth/deviceFlow.ts`,
 *   which is the only piece reused here.
 */

import os from 'node:os';
import { pollDeviceToken } from '../lib/auth/deviceFlow.js';
import { tryProvisionSharedApiKey } from '../lib/auth/provision.js';
import type { ToolDefinition, ToolDispatchOpts } from '../lib/tool.js';

/**
 * Default polling window when the agent doesn't carry the original
 * device-code response forward. 600s matches the cloud's current
 * device-code lifetime; 5s matches the cloud's recommended polling
 * cadence. Both are overridable so the production handler remains
 * testable without monkey-patching module state.
 */
const DEFAULT_EXPIRES_IN_SECONDS = 600;
const DEFAULT_INTERVAL_SECONDS = 5;

/**
 * Pure core of the resume flow. Mirrors the polling block of
 * `runLoreLogin` (steps 5–6 in the plan) without the device-code mint
 * or browser-open steps.
 *
 * `device_code` is treated as a bearer credential: it is never
 * surfaced in return values or thrown error messages (see the
 * `pollDeviceToken` doc for the credential-leak vector being closed).
 */
export async function runLoreLoginResume(opts: {
  device_code: string;
  expires_in_seconds?: number;
  interval_seconds?: number;
  fetchImpl: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  home: string;
  /**
   * Provision the shared Lore API key after a successful resume. Injected so
   * the pure core stays offline in tests; the production handler wires the
   * real (non-fatal) implementation. Defaults to a no-op.
   */
  provisionApiKey?: () => Promise<void>;
}): Promise<
  | { ok: true }
  | { ok: false; reason: 'expired_token'; message: string }
> {
  const result = await pollDeviceToken({
    device_code: opts.device_code,
    expires_in_seconds: opts.expires_in_seconds ?? DEFAULT_EXPIRES_IN_SECONDS,
    interval_seconds: opts.interval_seconds ?? DEFAULT_INTERVAL_SECONDS,
    fetchImpl: opts.fetchImpl,
    now: opts.now,
    sleep: opts.sleep,
    home: opts.home,
  });

  // Mirror lore_login: provision the shared API key once the headless resume
  // completes, so headless/SSH logins get the durable credential too.
  if (result.ok) {
    await (opts.provisionApiKey ?? (async () => {}))();
  }
  return result;
}

/** Default sleeper for the production handler. Mirrors `lore_login.ts`. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const loreLoginResumeTool: ToolDefinition = {
  name: 'lore_login_resume',
  description:
    'Resume a previously-started Lore login when browser auto-open failed. ' +
    'Pass the device_code returned by lore_login. Polls until you approve in ' +
    'your browser or the code expires.',
  inputSchema: {
    type: 'object',
    properties: {
      device_code: { type: 'string' },
    },
    required: ['device_code'],
    additionalProperties: false,
  },
  handler: async (args: unknown, opts?: ToolDispatchOpts) => {
    const { device_code } = args as { device_code: string };
    const home = opts?.home ?? os.homedir();
    return runLoreLoginResume({
      device_code,
      fetchImpl: globalThis.fetch,
      now: Date.now,
      sleep: defaultSleep,
      // Resume must persist under the same dispatcher home as lore_login so
      // the polled tokens land in the plugin's state dir, not the process HOME.
      home,
      provisionApiKey: () => tryProvisionSharedApiKey({ home }),
    });
  },
};
