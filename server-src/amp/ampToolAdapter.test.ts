import { describe, expect, test } from 'bun:test';
import type { ToolDefinition } from '../lib/tool';
import { toAmpToolDefinition } from './ampToolAdapter';

function makeTool(handler: ToolDefinition['handler']): ToolDefinition {
  return {
    name: 'lore_test_tool',
    description: 'A test Lore tool',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      additionalProperties: false,
    },
    handler,
  };
}

function resultText(result: Awaited<ReturnType<ReturnType<typeof toAmpToolDefinition>['execute']>>): string {
  expect(result).toBeDefined();
  if (typeof result === 'string') return result;
  return result!.map((block) => block.text).join('\n');
}

describe('toAmpToolDefinition', () => {
  test('preserves tool name, description, inputSchema, and calls handler with input', async () => {
    const inputs: unknown[] = [];
    const tool = makeTool(async (input) => {
      inputs.push(input);
      return { ok: true, input };
    });

    const ampTool = toAmpToolDefinition(tool);
    const input = { query: 'hello' };
    const result = await ampTool.execute(input, {});

    expect(ampTool.name).toBe('lore_test_tool');
    expect(ampTool.description).toBe('A test Lore tool');
    expect(ampTool.inputSchema).toBe(tool.inputSchema);
    expect(inputs).toEqual([input]);
    expect(resultText(result)).toBe(JSON.stringify({ ok: true, input }));
  });

  test('returns string handler results as text output without JSON quoting', async () => {
    const ampTool = toAmpToolDefinition(makeTool(async () => 'plain output'));

    const result = await ampTool.execute({}, {});

    expect(resultText(result)).toBe('plain output');
  });

  test('converts MCP-shaped text content to valid Amp text content', async () => {
    const ampTool = toAmpToolDefinition(
      makeTool(async () => ({
        isError: true,
        content: [
          { type: 'text', text: 'Please run lore_login first.' },
          { type: 'text', text: 'Then retry the tool.' },
        ],
      })),
    );

    const result = await ampTool.execute({}, {});

    expect(result).toEqual([
      { type: 'text', text: 'Please run lore_login first.' },
      { type: 'text', text: 'Then retry the tool.' },
    ]);
  });

  test('renders unsupported MCP content blocks as valid Amp text content', async () => {
    const ampTool = toAmpToolDefinition(
      makeTool(async () => ({
        content: [
          { type: 'image', data: 'abc123', mimeType: 'image/png' },
          { type: 'resource', resource: { uri: 'lore://thread/1' } },
        ],
      })),
    );

    const result = await ampTool.execute({}, {});

    expect(result).toEqual([
      { type: 'text', text: JSON.stringify({ type: 'image', data: 'abc123', mimeType: 'image/png' }) },
      { type: 'text', text: JSON.stringify({ type: 'resource', resource: { uri: 'lore://thread/1' } }) },
    ]);
  });
});
