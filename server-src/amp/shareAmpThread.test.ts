import { describe, expect, test } from 'bun:test';
import {
  createShareCurrentAmpThreadTool,
  runAmpThreadExportWithShell,
  shareAmpThread,
} from './shareAmpThread';

function ampExportJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'amp-thread-1',
    title: 'Amp Thread Title',
    messages: [],
    ...overrides,
  });
}

describe('shareAmpThread', () => {
  test('runAmpThreadExportWithShell uses the Amp command context shell for thread export', async () => {
    const shellCalls: Array<{ strings: string[]; values: unknown[] }> = [];

    const exported = await runAmpThreadExportWithShell('T-amp-thread', async (strings, ...values) => {
      shellCalls.push({ strings: [...strings], values });
      return { exitCode: 0, stdout: ampExportJson(), stderr: '' };
    });

    expect(exported).toBe(ampExportJson());
    expect(shellCalls).toEqual([
      {
        strings: ['amp threads export ', ''],
        values: ['T-amp-thread'],
      },
    ]);
  });

  test('explicit threadId wins over AMP_CURRENT_THREAD_ID and forwards raw export as amp transcript', async () => {
    const exportJson = ampExportJson();
    const exportedThreadIds: string[] = [];
    const shareCalls: Array<{
      args: Record<string, unknown>;
      opts: { harness: 'amp' };
    }> = [];

    const result = await shareAmpThread(
      { threadId: 'explicit-thread', visibility: 'workspace', highlight: ' where the parser changed ' },
      {
        env: { AMP_CURRENT_THREAD_ID: 'env-thread' },
        ampBaseUrl: new URL('https://ampcode.com/threads/'),
        runAmpExport: async (threadId) => {
          exportedThreadIds.push(threadId);
          return exportJson;
        },
        share: async (args, opts) => {
          shareCalls.push({ args, opts });
          return { thread_id: 'lore-1', thread_url: 'https://lore.test/lore-1' };
        },
      },
    );

    expect(result).toEqual({
      thread_id: 'lore-1',
      thread_url: 'https://lore.test/lore-1',
    });
    expect(exportedThreadIds).toEqual(['explicit-thread']);
    expect(shareCalls).toHaveLength(1);
    expect(shareCalls[0]!.opts).toEqual({ harness: 'amp' });
    expect(shareCalls[0]!.args).toMatchObject({
      transcript: exportJson,
      title: 'Amp Thread Title',
      source_url: 'https://ampcode.com/threads/explicit-thread',
      visibility: 'workspace',
      highlight: 'where the parser changed',
    });
  });

  test('uses AMP_CURRENT_THREAD_ID when no explicit threadId is supplied', async () => {
    const exportedThreadIds: string[] = [];

    await shareAmpThread(
      {},
      {
        env: { AMP_CURRENT_THREAD_ID: 'env-thread' },
        runAmpExport: async (threadId) => {
          exportedThreadIds.push(threadId);
          return ampExportJson({ title: 'From Env' });
        },
        share: async () => ({ thread_id: 'lore-2', thread_url: 'https://lore.test/lore-2' }),
      },
    );

    expect(exportedThreadIds).toEqual(['env-thread']);
  });

  test('missing thread id throws an actionable error and does not export or upload', async () => {
    let exportCalls = 0;
    let shareCalls = 0;

    await expect(
      shareAmpThread(
        {},
        {
          env: {},
          runAmpExport: async () => {
            exportCalls += 1;
            return ampExportJson();
          },
          share: async () => {
            shareCalls += 1;
            return {};
          },
        },
      ),
    ).rejects.toThrow(/No active Amp thread.*ctx\.thread.*AMP_CURRENT_THREAD_ID/i);

    expect(exportCalls).toBe(0);
    expect(shareCalls).toBe(0);
  });

  test('omits optional metadata and visibility when not supplied or not straightforward', async () => {
    const exportJson = '{"messages":[]}';
    let shareArgs: Record<string, unknown> | undefined;

    await shareAmpThread(
      { threadId: 'amp-thread-3' },
      {
        env: {},
        runAmpExport: async () => exportJson,
        share: async (args) => {
          shareArgs = args;
          return { thread_id: 'lore-3', thread_url: 'https://lore.test/lore-3' };
        },
      },
    );

    expect(shareArgs).toEqual({ transcript: exportJson });
  });

  test('preserves MCP/auth-required result shapes from share core', async () => {
    const authRequired = {
      isError: true,
      content: [{ type: 'text', text: 'Please run lore_login first.' }],
    };

    const result = await shareAmpThread(
      { threadId: 'amp-thread-4' },
      {
        env: {},
        runAmpExport: async () => ampExportJson(),
        share: async () => authRequired,
      },
    );

    expect(result).toBe(authRequired);
  });

  test('share_current_amp_thread Amp tool shares an explicitly supplied thread_id', async () => {
    const exportJson = ampExportJson({ title: 'Tool Share' });
    const exportedThreadIds: string[] = [];
    const shareCalls: Array<{ args: Record<string, unknown>; opts: { harness: 'amp' } }> = [];
    const tool = createShareCurrentAmpThreadTool({
      env: { AMP_CURRENT_THREAD_ID: 'env-thread' },
      runAmpExport: async (threadId) => {
        exportedThreadIds.push(threadId);
        return exportJson;
      },
      share: async (args, opts) => {
        shareCalls.push({ args, opts });
        return { thread_id: 'lore-tool', thread_url: 'https://lore.test/lore-tool' };
      },
    });

    const result = await tool.execute(
      {
        thread_id: 'explicit-tool-thread',
        visibility: 'public',
        highlight: 'show the API fix',
      },
      {},
    );

    expect(tool.name).toBe('share_current_amp_thread');
    expect(tool.inputSchema).toEqual({
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        visibility: { type: 'string', enum: ['private', 'workspace', 'public'] },
        highlight: {
          type: 'string',
          description:
            'Natural-language description of the block or block range to highlight in the returned Lore URL.',
        },
      },
      additionalProperties: false,
    });
    expect(result).toBe(JSON.stringify({ thread_id: 'lore-tool', thread_url: 'https://lore.test/lore-tool' }));
    expect(exportedThreadIds).toEqual(['explicit-tool-thread']);
    expect(shareCalls).toEqual([
      {
        args: {
          transcript: exportJson,
          title: 'Tool Share',
          visibility: 'public',
          highlight: 'show the API fix',
        },
        opts: { harness: 'amp' },
      },
    ]);
  });

  test('share_current_amp_thread Amp tool uses the active tool context thread when no thread_id is supplied', async () => {
    const exportedThreadIds: string[] = [];
    const tool = createShareCurrentAmpThreadTool({
      env: { AMP_CURRENT_THREAD_ID: 'env-thread' },
      runAmpExport: async (threadId) => {
        exportedThreadIds.push(threadId);
        return ampExportJson({ title: 'Context Tool Share' });
      },
      share: async () => ({ thread_id: 'lore-context-tool', thread_url: 'https://lore.test/lore-context-tool' }),
    });

    const result = await tool.execute({}, { thread: { id: 'context-thread' } });

    expect(result).toBe(JSON.stringify({ thread_id: 'lore-context-tool', thread_url: 'https://lore.test/lore-context-tool' }));
    expect(exportedThreadIds).toEqual(['context-thread']);
  });

  test('share_current_amp_thread Amp tool returns an actionable text error when no thread is resolvable', async () => {
    let exportCalls = 0;
    let shareCalls = 0;
    const tool = createShareCurrentAmpThreadTool({
      env: {},
      runAmpExport: async () => {
        exportCalls += 1;
        return ampExportJson();
      },
      share: async () => {
        shareCalls += 1;
        return {};
      },
    });

    const result = await tool.execute({}, {});

    expect(result).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(/Pass thread_id.*AMP_CURRENT_THREAD_ID/i),
      },
    ]);
    expect(exportCalls).toBe(0);
    expect(shareCalls).toBe(0);
  });
});
