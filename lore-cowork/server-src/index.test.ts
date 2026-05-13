/**
 * Tests for the in-process validator that gates `tools/call` arguments
 * against each tool's `inputSchema`.
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
 */
import { describe, test, expect } from 'bun:test';
import type { ToolInputSchema } from './lib/tool';
import { listLocalSessionsTool } from './tools/listLocalSessions';
import { validateAgainstSchema } from './index';

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
