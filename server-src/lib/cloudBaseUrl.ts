/**
 * Origin for the cloud MCP server and its OAuth endpoints.
 *
 * Why this is its own leaf:
 *   Three callers need the same origin string:
 *     - `lib/auth/refresh.ts` — POSTs to the discovered token endpoint to refresh.
 *     - `lib/cloudCall.ts` — fans out arbitrary proxy calls.
 *     - `tools/lore_login.ts` — kicks off the device-authorization flow.
 *   Centralizing the resolution rule (env override, trailing-slash
 *   normalization, validation) is the only way to guarantee those three
 *   callers can never end up pointing at three different hosts.
 *
 * Why we cache at module load:
 *   The cloud OAuth flow stretches across multiple tool calls within one
 *   plugin process: `lore_login` writes tokens, later proxy calls refresh
 *   them, and any of those can race. If we re-read `process.env` on each
 *   call, a test or a misbehaving subprocess could flip the origin mid-
 *   session and split a refresh against one host from the write that
 *   followed against another. The cache pins us to one origin for the
 *   life of the process.
 *
 *   The `__resetCloudBaseUrlForTests` escape hatch exists solely so the
 *   test suite can flip between prod and a localhost test server without
 *   restarting Bun. Production callers never invoke it.
 *
 * Why we fail loud on a malformed URL:
 *   A typo in `LORE_MCP_BASE_URL` (e.g. dropping the scheme) would
 *   otherwise surface much later as a confusing `fetch` failure inside
 *   `auth/refresh.ts` — and at that point we've already burned a refresh
 *   token write/read cycle and confused the user. Validating at load
 *   time turns the error into a single legible message that names the
 *   env var.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Production origin. Trailing slash deliberately absent so all call
 * sites can write `${cloudBaseUrl()}/oauth/token` without doubling.
 */
const PROD_DEFAULT = 'https://mcp.lore.link';

const ENV_VAR_NAME = 'LORE_MCP_BASE_URL';
const MCP_PROXY_ENV_VAR_NAME = 'LORE_MCP_PROXY_BASE_URL';

let cached: string | null = null;
let cachedMcpProxy: string | null = null;

/**
 * Read the env var, validate, and normalize. Throws a labeled error
 * if the env var contains a non-URL string.
 *
 * Why we treat `''` like unset: shell scripts that `export VAR=`
 * (intending to clear) leave the env entry present-but-empty. Treating
 * empty as unset is the principle-of-least-surprise behavior; an empty
 * URL is never a valid override anyway.
 */
function resolve(): string {
  return resolveEnvUrl(ENV_VAR_NAME, PROD_DEFAULT);
}

function resolveMcpProxy(): string {
  return resolveEnvUrl(MCP_PROXY_ENV_VAR_NAME, installedPluginMcpBaseUrl() ?? cloudBaseUrl());
}

function installedPluginMcpBaseUrl(): string | null {
  const stateDir = process.env.LORE_PLUGIN_STATE_DIR?.trim();
  if (!stateDir) return null;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'harness', 'amp', 'lore-plugin', 'lore-plugin-config.json'), 'utf8'),
    ) as { mcpBaseUrl?: unknown };
    if (typeof parsed.mcpBaseUrl !== 'string' || !parsed.mcpBaseUrl.trim()) return null;
    return normalizeUrl(parsed.mcpBaseUrl, 'installed plugin config mcpBaseUrl');
  } catch {
    return null;
  }
}

function normalizeUrl(raw: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL: ${JSON.stringify(raw)}.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use http or https; got ${JSON.stringify(raw)}.`);
  }
  return raw.replace(/\/+$/, '');
}

function resolveEnvUrl(envVarName: string, fallback: string): string {
  const raw = process.env[envVarName];
  if (raw === undefined || raw === '') return fallback;
  // Validate before stripping slashes, so a bare "/" or similar nonsense
  // still trips the validator instead of normalizing to an empty string.
  // Strip every trailing slash. `URL`'s own serialization normalizes a
  // bare-origin URL to end in `/` (e.g. `http://x/`), so this also
  // covers the case where the user supplied no path at all.
  return normalizeUrl(raw, envVarName);
}

/**
 * The cached base URL. Resolved on first call and on every
 * `__resetCloudBaseUrlForTests` call. Never re-reads the env var
 * otherwise.
 */
export function cloudBaseUrl(): string {
  if (cached === null) {
    cached = resolve();
  }
  return cached;
}

/**
 * Base URL used only for JSON-RPC proxy calls to `/mcp`.
 *
 * Defaults to `cloudBaseUrl()` so production uses the same origin for PRM,
 * AuthKit discovery, refresh, login, and MCP tool calls. Test packages can set
 * `LORE_MCP_PROXY_BASE_URL` to point only the proxied MCP call at a local API
 * server while keeping OAuth discovery/refresh against production AuthKit.
 */
export function cloudMcpBaseUrl(): string {
  if (cachedMcpProxy === null) {
    cachedMcpProxy = resolveMcpProxy();
  }
  return cachedMcpProxy;
}

/**
 * Test-only: drop the cached value and re-resolve on the next call.
 * Synchronous, so callers can `__reset…(); expect(cloudBaseUrl()).toBe(…)`
 * without microtask boundaries between the two.
 *
 * If the env var is currently invalid, this throws — matching the
 * "fail loud at load time" semantics so a test that sets a bad env
 * value fails on the reset call, not on a later cloud call.
 */
export function __resetCloudBaseUrlForTests(): void {
  cached = resolve();
  cachedMcpProxy = resolveMcpProxy();
}
