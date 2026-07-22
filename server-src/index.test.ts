/**
 * Tests for the in-process validator that gates `tools/call` arguments
 * against each tool's `inputSchema`, plus end-to-end dispatch tests that
 * exercise tool-handler wiring via `dispatchToolCall`.
 *
 * Why these tests exist: the `@modelcontextprotocol/sdk` validates only
 * the JSON-RPC envelope for `tools/call` (see
 * `node_modules/@modelcontextprotocol/sdk/dist/esm/types.js`
 * `CallToolRequestParamsSchema`, where `arguments` is typed as
 * `z.record(z.string(), z.unknown()).optional()`). It does NOT check
 * `arguments` against the tool's `inputSchema`. The plugin enforces
 * conformance in `index.ts` and throws `McpError(InvalidParams)` on a
 * mismatch — this file pins that behavior in place so future SDK
 * upgrades that DO add schema enforcement still leave the contract
 * intact, and a regression that removes the validator surfaces here.
 *
 * We exercise `validateAgainstSchema` directly rather than booting the
 * stdio transport — same logic, no scaffolding cost. A second test
 * walks `listLocalSessionsTool` through its real `inputSchema` to
 * confirm the empty-object-with-no-additionals contract round-trips.
 *
 * The `dispatchToolCall` integration tests use a temp home dir seeded via
 * dispatch options so all state is hermetic and no real network calls are
 * made.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ToolInputSchema } from './lib/tool';
import { listLocalSessionsTool } from './tools/listLocalSessions';
import { validateAgainstSchema, dispatchToolCall } from './index';
import { readTokens } from './lib/auth/store';
import { __resetCloudBaseUrlForTests } from './lib/cloudBaseUrl';
import { __resetInFlightForTests as __resetDiscoveryInFlightForTests } from './lib/auth/discovery';

describe('validateAgainstSchema — additionalProperties: false', () => {
  const schema: ToolInputSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  };

  test('accepts an empty object', () => {
    expect(validateAgainstSchema(schema, {})).toBeNull();
  });

  test('rejects an object with any unknown field', () => {
    const err = validateAgainstSchema(schema, { sessionId: 'abc' });
    expect(err).not.toBeNull();
    expect(err).toContain("'sessionId'");
    expect(err).toContain('additionalProperties');
  });

  test('rejects an array (must be an object)', () => {
    expect(validateAgainstSchema(schema, [])).not.toBeNull();
  });

  test('rejects null (must be an object)', () => {
    expect(validateAgainstSchema(schema, null)).not.toBeNull();
  });

  test('rejects a string (must be an object)', () => {
    expect(validateAgainstSchema(schema, 'oops')).not.toBeNull();
  });
});

describe('validateAgainstSchema — required + property types', () => {
  const schema: ToolInputSchema = {
    type: 'object',
    properties: {
      session_id: { type: 'string' },
      verbose: { type: 'boolean' },
      limit: { type: 'integer' },
    },
    required: ['session_id'],
    additionalProperties: false,
  };

  test('accepts a fully-specified valid arg set', () => {
    expect(
      validateAgainstSchema(schema, {
        session_id: 'sess',
        verbose: true,
        limit: 5,
      }),
    ).toBeNull();
  });

  test('accepts only the required field', () => {
    expect(validateAgainstSchema(schema, { session_id: 'sess' })).toBeNull();
  });

  test('rejects missing required field', () => {
    const err = validateAgainstSchema(schema, { verbose: true });
    expect(err).toContain("'session_id'");
    expect(err).toContain('required');
  });

  test('rejects wrong type on string field', () => {
    const err = validateAgainstSchema(schema, { session_id: 42 });
    expect(err).toContain("'session_id'");
    expect(err).toContain('string');
  });

  test('rejects wrong type on boolean field', () => {
    const err = validateAgainstSchema(schema, {
      session_id: 'sess',
      verbose: 'yes',
    });
    expect(err).toContain("'verbose'");
    expect(err).toContain('boolean');
  });

  test('rejects non-integer number on integer field', () => {
    const err = validateAgainstSchema(schema, {
      session_id: 'sess',
      limit: 1.5,
    });
    expect(err).toContain("'limit'");
    expect(err).toContain('integer');
  });

  test('rejects unknown extra field (camelCase typo)', () => {
    const err = validateAgainstSchema(schema, {
      session_id: 'sess',
      sessionID: 'oops',
    });
    expect(err).toContain("'sessionID'");
    expect(err).toContain('additionalProperties');
  });
});

describe('validateAgainstSchema — listLocalSessionsTool integration', () => {
  test('accepts {} against the real list_local_sessions schema', () => {
    expect(
      validateAgainstSchema(listLocalSessionsTool.inputSchema, {}),
    ).toBeNull();
  });

  test('rejects any extra arg against list_local_sessions (the camelCase typo case)', () => {
    const err = validateAgainstSchema(listLocalSessionsTool.inputSchema, {
      sessionId: 'whatever',
    });
    expect(err).not.toBeNull();
    expect(err).toContain("'sessionId'");
  });
});

// ── dispatchToolCall integration tests ────────────────────────────────────────

describe('dispatchToolCall — end-to-end dispatch wiring', () => {
  let tmpHome: string;

  beforeEach(async () => {
    tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'lore-dispatch-test-'));
  });

  afterEach(async () => {
    await fsp.rm(tmpHome, { recursive: true, force: true });
    delete process.env.LORE_MCP_BASE_URL;
    __resetCloudBaseUrlForTests();
    __resetDiscoveryInFlightForTests();
  });

  test('validates share_session arguments before invoking the handler', async () => {
    await expect(
      dispatchToolCall(
        { name: 'share_session', arguments: { __not_a_real_field: true } },
        { home: tmpHome },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
  });

  test('unknown tool name → throws McpError with MethodNotFound', async () => {
    await expect(
      dispatchToolCall({ name: 'totally_unknown_tool' }, { home: tmpHome }),
    ).rejects.toMatchObject({
      code: ErrorCode.MethodNotFound,
    });
  });

  test('unknown tool name → McpError message mentions the tool name', async () => {
    let thrown: unknown;
    try {
      await dispatchToolCall({ name: 'no_such_tool' }, { home: tmpHome });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(McpError);
    expect((thrown as McpError).message).toContain('no_such_tool');
  });

  // The headless device-flow path. `lore_login_resume` never spawns a browser
  // (`open`), so it exercises the same opts.home → writeTokens routing as
  // `lore_login` but stays deterministic on Linux CI. This is the primary
  // regression guard for the dispatcher-home fix on both login tools.
  test('lore_login_resume writes tokens under the dispatcher home, not process HOME', async () => {
    const processHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'lore-dispatch-process-home-'));
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    const testBase = 'https://mcp.example.test';
    const authBase = 'https://signin.example.test';
    const tokenEndpoint = `${authBase}/oauth2/token`;

    process.env.HOME = processHome;
    process.env.LORE_MCP_BASE_URL = testBase;
    __resetCloudBaseUrlForTests();
    __resetDiscoveryInFlightForTests();

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlString =
        typeof url === 'string'
          ? url
          : url instanceof URL
            ? url.toString()
            : url.url;
      if (urlString === `${testBase}/.well-known/oauth-protected-resource/mcp`) {
        return Response.json({
          resource: 'https://api.example.test',
          authorization_servers: [authBase],
        });
      }
      if (urlString === `${authBase}/.well-known/oauth-authorization-server`) {
        return Response.json({
          issuer: authBase,
          token_endpoint: tokenEndpoint,
        });
      }
      if (urlString === tokenEndpoint) {
        expect(init?.body?.toString()).toContain('device_code=device-code');
        return Response.json({
          access_token: 'access-from-resume',
          refresh_token: 'refresh-from-resume',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      throw new Error(`unexpected fetch URL: ${urlString}`);
    }) as typeof fetch;

    try {
      const result = await dispatchToolCall(
        { name: 'lore_login_resume', arguments: { device_code: 'device-code' } },
        { home: tmpHome },
      );

      const text = result.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: string; text: string }).text)
        .join('');
      expect(JSON.parse(text)).toEqual({ ok: true });
      expect((await readTokens(tmpHome))?.access_token).toBe('access-from-resume');
      expect(await readTokens(processHome)).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await fsp.rm(processHome, { recursive: true, force: true });
    }
    // The device-flow poll sleeps DEFAULT_INTERVAL_SECONDS (5s) before its
    // first token request, so allow comfortably more than bun's 5s default.
  }, 15000);

  test('lore_login writes tokens under the dispatcher home, not process HOME', async () => {
    const processHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'lore-dispatch-process-home-'));
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    const testBase = 'https://mcp.example.test';
    const authBase = 'https://signin.example.test';
    const deviceEndpoint = `${authBase}/oauth2/device_authorization`;
    const tokenEndpoint = `${authBase}/oauth2/token`;
    const openedUrls: string[] = [];

    process.env.HOME = processHome;
    process.env.LORE_MCP_BASE_URL = testBase;
    __resetCloudBaseUrlForTests();
    __resetDiscoveryInFlightForTests();

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlString =
        typeof url === 'string'
          ? url
          : url instanceof URL
            ? url.toString()
            : url.url;
      if (urlString === `${testBase}/.well-known/oauth-protected-resource/mcp`) {
        return Response.json({
          resource: 'https://api.example.test',
          authorization_servers: [authBase],
        });
      }
      if (urlString === `${authBase}/.well-known/oauth-authorization-server`) {
        return Response.json({
          issuer: authBase,
          token_endpoint: tokenEndpoint,
        });
      }
      if (urlString === deviceEndpoint) {
        return Response.json({
          device_code: 'device-code',
          user_code: 'USER-CODE',
          verification_uri: 'https://signin.example.test/device',
          verification_uri_complete: 'https://signin.example.test/device?user_code=USER-CODE',
          expires_in: 600,
          interval: 1,
        });
      }
      if (urlString === tokenEndpoint) {
        expect(init?.body?.toString()).toContain('device_code=device-code');
        return Response.json({
          access_token: 'access-from-login',
          refresh_token: 'refresh-from-login',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      throw new Error(`unexpected fetch URL: ${urlString}`);
    }) as typeof fetch;

    try {
      const result = await dispatchToolCall(
        { name: 'lore_login', arguments: {} },
        {
          home: tmpHome,
          openBrowser: (url) => {
            openedUrls.push(url);
            return { status: 0 };
          },
        },
      );

      const text = result.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { type: string; text: string }).text)
        .join('');
      expect(JSON.parse(text)).toEqual({ ok: true });
      expect(openedUrls).toEqual(['https://signin.example.test/device?user_code=USER-CODE']);
      expect((await readTokens(tmpHome))?.access_token).toBe('access-from-login');
      expect(await readTokens(processHome)).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await fsp.rm(processHome, { recursive: true, force: true });
    }
  });
});
