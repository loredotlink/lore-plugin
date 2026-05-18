/**
 * Shared OAuth client constants for the AuthKit migration.
 *
 * These are public values — not secrets — and are safe to commit to source.
 * Per RFC 8252 §8.4, native OAuth clients (including CLI/MCP plugins) are
 * "public clients": the client_id is not a credential and its exposure to
 * end users is expected and intentional. WorkOS AuthKit enforces PKCE and
 * device-flow constraints on the client registration rather than relying on
 * a secret.
 */

/**
 * WorkOS AuthKit client id registered for this plugin.
 *
 * Used in every OAuth token request — device-code polling, refresh — as the
 * `client_id` form parameter. This is a public OAuth client id (per
 * RFC 8252 §8.4): it is registered in WorkOS AuthKit, safe to commit to
 * source, and not a credential.
 */
export const AUTHKIT_CLIENT_ID = 'client_01KRSDB9SR20N7MB0D9MPS05Q6';

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
export const AUTHKIT_SCOPES = 'openid email profile offline_access';
