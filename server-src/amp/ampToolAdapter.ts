import type { ToolDefinition, ToolInputSchema } from '../lib/tool.js';

export type AmpPluginTextContent = { type: 'text'; text: string };
export type AmpPluginToolResult = string | AmpPluginTextContent[];
export type AmpPluginToolContext = unknown;
export type AmpPluginToolDefinition = {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  execute: (
    input: Record<string, unknown>,
    ctx: AmpPluginToolContext,
  ) => Promise<AmpPluginToolResult | void>;
};

type McpLikeResult = {
  content?: unknown;
  isError?: boolean;
};

export function toAmpToolDefinition(tool: ToolDefinition): AmpPluginToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: async (input: Record<string, unknown>) => toAmpToolResult(await tool.handler(input)),
  };
}

export function toAmpToolResult(value: unknown): AmpPluginToolResult {
  if (isMcpLikeResult(value)) {
    return value.content.map(contentBlockToText);
  }

  if (typeof value === 'string') {
    return value;
  }

  return stringifyForToolResult(value);
}

function isMcpLikeResult(value: unknown): value is McpLikeResult & { content: unknown[] } {
  return (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray((value as McpLikeResult).content)
  );
}

function contentBlockToText(block: unknown): AmpPluginTextContent {
  if (
    block !== null &&
    typeof block === 'object' &&
    (block as { type?: unknown }).type === 'text' &&
    typeof (block as { text?: unknown }).text === 'string'
  ) {
    return { type: 'text', text: (block as { text: string }).text };
  }

  return { type: 'text', text: stringifyForToolResult(block) };
}

function stringifyForToolResult(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch (error) {
    return `Tool returned a value that could not be serialized: ${(error as Error).message}`;
  }
}
