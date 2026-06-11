/**
 * Endpoint discovery via PRM → AS metadata.
 *
 * The protocol implementation lives in `@lore/identity-store` so the CLI and
 * plugin refresh the same AuthKit tokens through the same discovery rules. This
 * file keeps the plugin-local public API, environment selection, and in-flight
 * de-duplication used by the MCP tools.
 */

import os from 'node:os';
import path from 'node:path';
import {
  buildProtectedResourceMetadataUrl,
  discoverOAuthEndpoints,
  discoveryCacheFilePath as sharedDiscoveryCacheFilePath,
  type OAuthDiscoveredEndpoints,
} from '@lore/identity-store';
import { cloudBaseUrl } from '../cloudBaseUrl';

export type DiscoveredEndpoints = OAuthDiscoveredEndpoints;

function stateDir(home: string = os.homedir()): string {
  return path.join(home, '.lore');
}

function resourceUrl(base: string): string {
  return `${base}/mcp`;
}

export function discoveryCacheFilePath(home: string = os.homedir()): string {
  return sharedDiscoveryCacheFilePath(stateDir(home));
}

export function protectedResourceMetadataUrl(base: string): string {
  return buildProtectedResourceMetadataUrl(resourceUrl(base));
}

let inFlight: Promise<DiscoveredEndpoints> | null = null;

export function __resetInFlightForTests(): void {
  inFlight = null;
}

export function discoverEndpoints(opts?: {
  fetchImpl?: typeof fetch;
  home?: string;
  now?: () => number;
}): Promise<DiscoveredEndpoints> {
  if (inFlight) return inFlight;
  const base = cloudBaseUrl();
  const p = discoverOAuthEndpoints({
    resource: resourceUrl(base),
    stateDir: stateDir(opts?.home),
    fetchImpl: opts?.fetchImpl,
    now: opts?.now,
  }).finally(() => {
    inFlight = null;
  });
  inFlight = p;
  return p;
}
