/**
 * MCP tool: `lore_login`.
 *
 * Cold-start authentication path for the cloud Lore tools. Drives the
 * RFC 8628 OAuth device-authorization flow end-to-end inside a single
 * blocking tool call:
 *
 *   1. Call `initiateDeviceCode()` to discover endpoints and mint a
 *      device_code + user_code pair via AuthKit.
 *   2. `spawn('open', [verification_uri_complete])` so the user lands
 *      directly on the consent screen with the code pre-filled.
 *   3. Poll via `pollDeviceToken(...)` until the user clicks Allow, the
 *      cloud returns `expired_token`, or the local hard cap kicks in.
 *   4. On success, `pollDeviceToken` persists tokens via `writeTokens`
 *      from `lib/auth/store.ts`.
 *
 * Why this is the agent's escape hatch, not a fully automatic flow:
 *   The plugin runs inside a stdio MCP server hosted by Claude Code.
 *   We cannot post a UI; the only sanctioned way to involve the human
 *   is to open a browser tab. When `open` fails (SSH session, no GUI,
 *   sandboxed runtime) we surface the `verification_uri` + `device_code`
 *   so the agent can hand off to `lore_login_resume`, which polls the
 *   same flow from a headless context using a code the user pastes
 *   onto their own device.
 *
 * Why the agent-visible description names `lore_login_resume` literally:
 *   The agent has no other signal that a fallback tool exists. Without
 *   the name in the description, a `browser_open_failed` response
 *   would dead-end the conversation. The literal-name reference is
 *   what lets the agent chain the two tools without prompting.
 *
 * Why polling is sync-blocking (not streaming):
 *   Cowork's JSON-RPC framing does not deliver partial tool results.
 *   We therefore loop in-process until the flow terminates, which is
 *   bounded by the device-code lifetime the server returns. The agent
 *   sees one tool call returning one result, never a stream.
 *
 * Testability:
 *   The pure `runLoreLogin` accepts injected `fetchImpl`, `spawnImpl`,
 *   `now`, `sleep`, and `home`. Tests pass deterministic fakes; the
 *   wrapped `handler` closes over `globalThis.fetch`, `spawnSync` (with
 *   `{stdio: 'ignore'}` to keep stdout reserved for JSON-RPC framing),
 *   `Date.now`, a setTimeout-backed sleeper, and the default home dir.
 *
 * Credential hygiene:
 *   `device_code`, `access_token`, and `refresh_token` are never
 *   written to stderr. On success the return value does not include
 *   the device_code or any token — only `{ok: true}`. On
 *   `browser_open_failed` the device_code is returned (necessary for
 *   `lore_login_resume`) and the user_code is returned so the user
 *   can visually compare against the consent screen.
 */

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { initiateDeviceCode, pollDeviceToken } from '../lib/auth/deviceFlow.js';
import type { ToolDefinition, ToolDispatchOpts } from '../lib/tool.js';

/**
 * Outcomes of `runLoreLogin`. Modeled as a discriminated union so the
 * tool handler can serialize each variant without ad-hoc branching, and
 * tests can assert the exact return shape per acceptance bullet.
 */
export type LoreLoginResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'browser_open_failed';
      device_code: string;
      user_code: string;
      verification_uri: string;
      message: string;
    }
  | {
      ok: false;
      reason: 'expired_token';
      message: string;
    };

/**
 * Pure core of the device-flow login. Performs no I/O of its own —
 * every external interaction is funneled through the injected dependencies.
 *
 * The polling loop semantics match RFC 8628 §3.5 (handled inside
 * `pollDeviceToken` from `lib/auth/deviceFlow.ts`):
 *   - `authorization_pending` → keep polling at the current interval.
 *   - `slow_down` → add 5 seconds to the local interval *for this and
 *      all subsequent waits*, then continue polling.
 *   - `expired_token` → return the typed failure shape.
 *   - 200 with token pair → persist + return `{ok: true}`.
 *   - Anything else (network error, unknown OAuth error) → throw
 *     verbatim. The handler in `index.ts` maps thrown errors to
 *     `McpError` responses.
 */
export async function runLoreLogin(opts: {
  fetchImpl: typeof fetch;
  spawnImpl: (cmd: string, args: string[]) => { status: number | null };
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  home: string;
}): Promise<LoreLoginResult> {
  const { fetchImpl, spawnImpl, now, sleep, home } = opts;

  // Step 1: discover endpoints and mint a device_code via AuthKit.
  const device = await initiateDeviceCode({ fetchImpl, home });

  // Step 2: open the browser. spawnImpl is sync-shaped to mirror
  // `spawnSync`; we only care about the exit status.
  const spawnResult = spawnImpl('open', [device.verification_uri_complete]);
  if (spawnResult.status !== 0) {
    return {
      ok: false,
      reason: 'browser_open_failed',
      device_code: device.device_code,
      user_code: device.user_code,
      verification_uri: device.verification_uri,
      message:
        `Could not open a browser tab automatically. Visit ${device.verification_uri} ` +
        `on any device, enter the code ${device.user_code} when prompted, then call ` +
        `\`lore_login_resume\` with this device_code to finish authentication.`,
    };
  }

  // Step 3: delegate to the poll loop. The loop handles the hard cap,
  // slow_down/authorization_pending/expired_token branching, and token
  // persistence on success.
  return pollDeviceToken({
    device_code: device.device_code,
    expires_in_seconds: device.expires_in,
    interval_seconds: device.interval,
    fetchImpl,
    now,
    sleep,
    home,
  });
}

/**
 * Default sleeper for the production handler. Resolves after `ms`
 * milliseconds using `setTimeout`. We do not use `Bun.sleep` here so
 * that the binary runs identically under Node and Bun for build-time
 * smoke tests.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const loreLoginTool: ToolDefinition = {
  name: 'lore_login',
  description:
    'Authenticate to Lore via device flow. Call this tool when other Lore tools return an auth-required error. ' +
    'A browser tab will open at the Lore consent screen with the device code pre-filled; the tool blocks ' +
    'until the user approves or the device code expires. If the browser cannot be opened automatically ' +
    '(e.g. SSH or headless environments), the tool returns a `browser_open_failed` result containing the ' +
    'verification URL and device code — in that case, instruct the user to visit the URL on any device and ' +
    'then call `lore_login_resume` with the returned `device_code` to finish authentication.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  handler: async (_args: unknown, opts?: ToolDispatchOpts): Promise<LoreLoginResult> => {
    return runLoreLogin({
      fetchImpl: globalThis.fetch,
      spawnImpl: (cmd, args) => {
        const r = spawnSync(cmd, args, { stdio: 'ignore' });
        return { status: r.status };
      },
      now: Date.now,
      sleep: defaultSleep,
      // Persist tokens under the dispatcher-provided home so the plugin's
      // token slot lands at the same path its other tools read from. Falling
      // back to os.homedir() only when no override is supplied keeps the
      // CLI/process HOME from clobbering the dispatcher's state dir.
      home: opts?.home ?? os.homedir(),
    });
  },
};
