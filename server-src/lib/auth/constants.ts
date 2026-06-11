import {
  AUTHKIT_CLIENT_ID as SHARED_AUTHKIT_CLIENT_ID,
  AUTHKIT_SCOPES as SHARED_AUTHKIT_SCOPES,
} from '@lore/identity-store';

/**
 * Shared OAuth client constants for the AuthKit migration.
 *
 * These are public values — not secrets — and are safe to commit to source.
 * Per RFC 8252 §8.4, native OAuth clients (including CLI/MCP plugins) are
 * "public clients": the client_id is not a credential and its exposure to
 * end users is expected and intentional.
 */

/**
 * WorkOS AuthKit client id for this plugin.
 *
 * Used in every OAuth token request — device-code polling, refresh — as the
 * `client_id` form parameter. This is a WorkOS Connect public application
 * configured for CLI Auth / RFC 8628 device authorization. It is public,
 * stable, safe to commit, and not a credential.
 *
 * Why static, not the CIMD URL:
 *   The CIMD URL (https://lore.link/.well-known/oauth-client.json)
 *   IS hosted and WorkOS Connect HAS CIMD enabled — but WorkOS's CIMD
 *   support is scoped to the Authorization Code + PKCE flow, not the
 *   device authorization grant. The AS metadata at
 *   /.well-known/oauth-authorization-server lists grant_types_supported
 *   as ['authorization_code', 'refresh_token'] only; the device grant
 *   lives on a separate endpoint and ignores CIMD lookups, returning
 *   `{error: "unauthorized"}` when given a CIMD URL as client_id.
 *
 *   This plugin must use the device flow because the auth-code +
 *   loopback redirect pattern can't survive remote Cowork sessions
 *   (browser callback can't reach a plugin-bound localhost listener
 *   across the local↔remote network gap). So the static client_id is
 *   the only client identity WorkOS device-auth accepts today.
 *
 *   The downstream consequence — WorkOS stamps the AuthKit app's own
 *   client_id as the JWT `aud` instead of the requested resource
 *   indicator — is handled by the `/mcp` resource server accepting
 *   both audience values. See apps/api/src/authProviders/workosMcp.ts.
 *
 *   When either (a) Cowork fixes streamable-http OAuth state
 *   persistence (re-enabling the spec-compliant auth-code path) or
 *   (b) WorkOS extends CIMD + resource indicators to device flow,
 *   this constant can switch to the CIMD URL and the audience-fallback
 *   in workosMcp.ts can be removed.
 */
export const AUTHKIT_CLIENT_ID = SHARED_AUTHKIT_CLIENT_ID;

/**
 * OAuth scopes requested by the device-code and refresh flows.
 *
 * These are standard OIDC scopes (RFC 6749 §3.3, OpenID Connect Core §5.4):
 *   - `openid`          Required by OIDC; causes the AS to return an id_token
 *                       alongside the access token and enables the UserInfo endpoint.
 *   - `email`           OIDC standard claim — the AS includes `email` and
 *                       `email_verified` in the id_token or UserInfo response.
 *   - `profile`         OIDC standard claim set — name, picture, locale, etc.
 *   - `offline_access`  RFC 6749 / OIDC Core §11 — causes the AS to return a
 *                       refresh_token so the plugin can maintain a session without
 *                       prompting the user to re-authenticate on every access-token
 *                       expiry.
 *
 * These replace the legacy `"mcp.read mcp.write"` scopes. The old scopes were
 * resource-server–specific permissions invented for the pre-AuthKit cloud. The
 * AuthKit migration shifts to audience-gated authorization: the access token's
 * `aud` claim is the resource server's identifier (from PRM discovery), and the
 * AS enforces what operations are permitted based on the client registration, not
 * a per-scope ACL. Requesting the legacy scopes against AuthKit would either be
 * rejected or silently ignored; requesting OIDC scopes is the correct contract
 * for a public device-flow client.
 */
export const AUTHKIT_SCOPES = SHARED_AUTHKIT_SCOPES;
