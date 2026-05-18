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
