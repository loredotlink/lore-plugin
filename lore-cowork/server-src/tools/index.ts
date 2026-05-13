/**
 * Tool barrel.
 *
 * Aggregates every tool the lore-cowork MCP host exposes. The stdio
 * entrypoint imports this array and wires it into the `ListTools` and
 * `CallTool` request handlers — adding a new tool means appending one
 * entry here and writing the tool file. No edits to `index.ts` needed.
 *
 * Order does not matter for correctness (handlers dispatch by name),
 * but it does drive the order in `tools/list` responses; clients that
 * display tools verbatim will see them in this order.
 */
import type { ToolDefinition } from '../lib/tool.js';
import { listLocalSessionsTool } from './listLocalSessions.js';

export const tools: ToolDefinition[] = [listLocalSessionsTool];
