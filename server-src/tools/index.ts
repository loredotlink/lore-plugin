/**
 * Tool barrel.
 *
 * Aggregates every tool the lore MCP host exposes. The stdio
 * entrypoint imports this array and wires it into the `ListTools` and
 * `CallTool` request handlers — adding a new tool means appending one
 * entry here and writing the tool file. No edits to `index.ts` needed.
 *
 * Order does not matter for correctness (handlers dispatch by name),
 * but it does drive the order in `tools/list` responses; clients that
 * display tools verbatim will see them in this order.
 */
import type { ToolDefinition } from '../lib/tool.js';
import { cloudProxyTools } from './cloudProxyTools.js';
import { listLocalSessionsTool } from './listLocalSessions.js';
import { loreLoginTool } from './lore_login.js';
import { loreLoginResumeTool } from './lore_login_resume.js';
import { readLocalSessionTool } from './readLocalSession.js';
import { shareSessionTool } from './share_session.js';

export const tools: ToolDefinition[] = [
  listLocalSessionsTool,
  readLocalSessionTool,
  loreLoginTool,
  loreLoginResumeTool,
  shareSessionTool,
  ...cloudProxyTools,
];
