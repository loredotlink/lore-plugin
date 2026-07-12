/**
 * Self-provision the shared, long-lived Lore API key from the plugin's login
 * flow.
 *
 * Why the plugin mints its own key (rather than relying on the CLI):
 *   The CLI's WorkOS User-Management token is accepted by the REST
 *   `createUploadApiKey` endpoint, but the plugin's AuthKit token carries the
 *   MCP audience and is rejected by that REST parser. So the plugin cannot mint
 *   over REST. Instead it calls the cloud `create_api_key` MCP tool — reachable
 *   with the MCP-audience token it already holds — and stores the returned raw
 *   key in the shared top-level `apiKey` slot every client reads. A user whose
 *   first (or only) Lore contact is the plugin's `lore_login` therefore still
 *   gets the durable credential that removes the refresh surface and fixes
 *   auto-share from credential-less child contexts.
 *
 * Why the raw key never touches the agent:
 *   `create_api_key` is intentionally NOT in the agent-facing proxy tool set
 *   (`cloudProxyTools`). It is invoked here, inside the plugin process, and the
 *   raw key is written straight to disk — it never appears in a tool result the
 *   model can see.
 *
 * Idempotent + non-fatal:
 *   Provisioning is skipped when a key is already present (env override or the
 *   stored slot), and any failure is swallowed to a stderr warning — OAuth
 *   remains a working fallback, so a provisioning blip must never fail login.
 */
import os from 'node:os';
import { readApiKey, writeApiKey } from '@lore/identity-store';
import { callCloudTool } from '../cloudCall.js';
import { stateDir } from './store.js';

const LORE_API_KEY_ENV = 'LORE_API_KEY';

function envApiKey(): string | null {
  const value = process.env[LORE_API_KEY_ENV]?.trim();
  return value && value.length > 0 ? value : null;
}

/**
 * Machine-legible name for the shared key so a user revoking keys in the web UI
 * can tell which host minted each one. The `plugin@` prefix records that the
 * plugin login flow provisioned it.
 */
export function pluginApiKeyName(hostname: string): string {
  return `plugin@${hostname}`;
}

/**
 * Extract the raw `lore_uak_` key from a `create_api_key` CallToolResult.
 *
 * The cloud tool returns the `createUploadApiKey` response body (a plain
 * object); the MCP server wraps a plain object as
 * `{ content: [{ type: 'text', text: <json> }] }`, so we parse the text node's
 * JSON and read `raw_key`. Returns null on any unexpected shape — the caller
 * treats that as a non-fatal provisioning miss rather than throwing.
 */
export function extractRawKey(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const node of content) {
    if (
      node &&
      typeof node === 'object' &&
      (node as { type?: unknown }).type === 'text' &&
      typeof (node as { text?: unknown }).text === 'string'
    ) {
      try {
        const parsed = JSON.parse((node as { text: string }).text) as {
          raw_key?: unknown;
        };
        if (typeof parsed.raw_key === 'string' && parsed.raw_key.length > 0) {
          return parsed.raw_key;
        }
      } catch {
        // Not JSON — keep scanning the remaining content nodes.
      }
    }
  }
  return null;
}

/** Injectable cloud-call seam so tests never touch the network. */
type CallCloudToolImpl = (
  toolName: string,
  args: Record<string, unknown>,
  opts?: { home?: string; fetchImpl?: typeof fetch },
) => Promise<unknown>;

/**
 * Mint the shared API key via the cloud `create_api_key` tool and persist it,
 * unless one already exists. Returns `{ provisioned: true }` only when it
 * actually stored a new key.
 */
export async function provisionSharedApiKey(
  opts: {
    home?: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
    hostname?: string;
    callCloudToolImpl?: CallCloudToolImpl;
  } = {},
): Promise<{ provisioned: boolean }> {
  const now = opts.now ?? Date.now;
  const hostname = opts.hostname ?? os.hostname();
  const call = opts.callCloudToolImpl ?? callCloudTool;

  // Idempotent: an env override or a stored key already covers this machine.
  if (envApiKey() !== null) return { provisioned: false };
  if ((await readApiKey(stateDir(opts.home))) !== null) return { provisioned: false };

  const result = await call(
    'create_api_key',
    { name: pluginApiKeyName(hostname) },
    { home: opts.home, fetchImpl: opts.fetchImpl },
  );
  const rawKey = extractRawKey(result);
  if (!rawKey) return { provisioned: false };

  await writeApiKey(stateDir(opts.home), { value: rawKey, created_at: now() });
  return { provisioned: true };
}

/**
 * Run provisioning without ever failing login — a stderr warning is the worst
 * case. Login already succeeded (tokens are persisted) by the time this runs;
 * OAuth keeps working even if the key is not provisioned.
 */
export async function tryProvisionSharedApiKey(opts: {
  home?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
} = {}): Promise<void> {
  try {
    await provisionSharedApiKey(opts);
  } catch (err) {
    console.error(
      '[lore-plugin] warning: API key provisioning failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}
