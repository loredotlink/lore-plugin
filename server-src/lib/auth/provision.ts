/**
 * Self-provision the shared, long-lived Lore API key from the plugin's login
 * flow.
 *
 * The plugin calls the upload-key REST endpoint with its MCP-audience token
 * and stores the returned key in the shared top-level `apiKey` slot.
 * A user whose first Lore contact is `lore_login` therefore gets the durable
 * credential needed by credential-less child contexts.
 *
 * Why the raw key never touches the agent:
 *   The REST call runs here, inside the plugin process, and the raw key is
 *   written straight to disk. There is no MCP tool result for the model to see.
 *
 * Idempotent + non-fatal:
 *   Provisioning is skipped when a key is already present (env override or the
 *   stored slot), and any failure is swallowed to a stderr warning — OAuth
 *   remains a working fallback, so a provisioning blip must never fail login.
 */
import os from 'node:os';
import { createUploadApiKeyResponseSchema } from '@lore/contracts';
import { readApiKey, writeApiKey } from '@lore/identity-store';
import { AuthRequiredError } from '../errors.js';
import { cloudMcpBaseUrl } from '../cloudBaseUrl.js';
import { forceRefreshAccessToken, getValidAccessToken } from './refresh.js';
import { deleteTokens, stateDir } from './store.js';

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

type CreateUploadApiKeyImpl = (
  name: string,
  opts: { home?: string; fetchImpl?: typeof fetch },
) => Promise<string | null>;

/**
 * Create the upload-only key through its REST owner. A 401 uses the same
 * retry-before-delete rule as cloud MCP calls. Error messages never include
 * response bodies because an upstream echo could contain a credential.
 */
export const createUploadApiKey: CreateUploadApiKeyImpl = async (
  name,
  opts,
) => {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const accessToken = await getValidAccessToken(opts);
  const post = (bearer: string) =>
    fetchImpl(`${cloudMcpBaseUrl()}/api/upload_api_keys`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name }),
    });

  let response = await post(accessToken);
  if (response.status === 401) {
    const refreshedToken = await forceRefreshAccessToken({
      previousAccessToken: accessToken,
      ...opts,
    });
    response = await post(refreshedToken);
    if (response.status === 401) {
      await deleteTokens(opts.home);
      throw new AuthRequiredError();
    }
  }

  if (!response.ok) {
    throw new Error(`Upload API key creation failed: HTTP ${response.status}`);
  }

  const parsed = createUploadApiKeyResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  return parsed.success ? parsed.data.raw_key : null;
};

/**
 * Mint the shared API key via the REST endpoint and persist it,
 * unless one already exists. Returns `{ provisioned: true }` only when it
 * actually stored a new key.
 */
export async function provisionSharedApiKey(
  opts: {
    home?: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
    hostname?: string;
    createUploadApiKeyImpl?: CreateUploadApiKeyImpl;
  } = {},
): Promise<{ provisioned: boolean }> {
  const now = opts.now ?? Date.now;
  const hostname = opts.hostname ?? os.hostname();
  const createKey = opts.createUploadApiKeyImpl ?? createUploadApiKey;

  // Idempotent: an env override or a stored key already covers this machine.
  if (envApiKey() !== null) return { provisioned: false };
  if ((await readApiKey(stateDir(opts.home))) !== null) return { provisioned: false };

  const rawKey = await createKey(
    pluginApiKeyName(hostname),
    { home: opts.home, fetchImpl: opts.fetchImpl },
  );
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
