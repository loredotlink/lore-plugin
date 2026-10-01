import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mcpShareSessionPluginResultSchema,
  mcpShareSessionResultSchema,
  mcpTextCallToolResultSchema,
  type McpShareSessionPluginResult,
  type McpShareSessionResult,
  type McpTextCallToolResult,
} from "@lore/contracts/mcp";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runShareSession, shareSessionFromDisk } from "./share_session";
import { AuthRequiredError, AUTH_REQUIRED_MESSAGE } from "../lib/errors";
import { writeTokens, type Tokens } from "../lib/auth/store";
import { __resetCloudBaseUrlForTests } from "../lib/cloudBaseUrl";
import { __resetInFlightForTests } from "../lib/auth/refresh";
import { __resetInFlightForTests as __resetDiscoveryInFlightForTests } from "../lib/auth/discovery";
import { ClaudeCodeSource } from "../lib/session/claudeCode";

import { CoworkSource } from "../lib/session/cowork";
import { encodeCwdToDir } from "@lore/transcript-locate";

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "share-session-test-"));
}
function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
function validTokens(): Tokens {
  return {
    access_token: "access-LIVE",
    refresh_token: "refresh-LIVE",
    expires_at: Date.now() + 60 * 60 * 1000,
    scope: "mcp.read mcp.write",
  };
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function textToolResult(payload: unknown): McpTextCallToolResult {
  return mcpTextCallToolResultSchema.parse({
    content: [{ type: "text", text: JSON.stringify(payload) }],
  });
}

function rpcShareSuccess(id: string, result: McpShareSessionResult): Response {
  const payload = mcpShareSessionResultSchema.parse(result);
  return jsonResponse({ jsonrpc: "2.0", id, result: textToolResult(payload) });
}

function readCloudShareResult(result: unknown): McpShareSessionResult {
  const toolResult = mcpTextCallToolResultSchema.parse(result);
  return mcpShareSessionResultSchema.parse(JSON.parse(toolResult.content[0]!.text));
}

function readPluginShareResult(result: unknown): McpShareSessionPluginResult {
  const toolResult = mcpTextCallToolResultSchema.parse(result);
  return mcpShareSessionPluginResultSchema.parse(JSON.parse(toolResult.content[0]!.text));
}

interface Captured {
  url: string;
  body: { id: string; params: { name: string; arguments: unknown } };
}

function captureFetch(responder: (req: Captured) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(init?.body as string);
    const cap: Captured = { url: String(url), body };
    calls.push(cap);
    return responder(cap);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("share_session tool", () => {
  let home: string;
  beforeEach(() => {
    home = makeTmpHome();
    __resetInFlightForTests();
    __resetDiscoveryInFlightForTests();
    process.env.LORE_MCP_BASE_URL = "http://localhost:4000";
    __resetCloudBaseUrlForTests();
  });
  afterEach(() => {
    rmrf(home);
    delete process.env.LORE_MCP_BASE_URL;
    __resetCloudBaseUrlForTests();
    __resetInFlightForTests();
    __resetDiscoveryInFlightForTests();
  });

  test("cloud-call core preserves omitted visibility for callers that use the cloud preference", async () => {
    await writeTokens(validTokens(), home);
    const expected = { thread_id: "t_abc", thread_url: "https://lore/t_abc" };
    const { fetchImpl, calls } = captureFetch((req) => rpcShareSuccess(req.body.id, expected));
    const result = await runShareSession({ transcript: "hello world" }, { fetchImpl, home });
    expect(readCloudShareResult(result)).toEqual(expected);
    expect(calls[0]!.body.params.name).toBe("share_session");
    expect(calls[0]!.body.params.arguments).toEqual({
      transcript: "hello world",
      harness: "cowork",
    });
  });

  test("plugin-supplied harness wins over caller-supplied harness", async () => {
    // Caller cannot do this via the schema (additionalProperties: false),
    // but the pure core spreads in the safe order even when called
    // directly. Lock the contract.
    await writeTokens(validTokens(), home);
    const { fetchImpl, calls } = captureFetch((req) =>
      rpcShareSuccess(req.body.id, {
        thread_id: "x",
        thread_url: "https://lore/x",
      }),
    );
    await runShareSession(
      { transcript: "t", harness: "something_else" } as Record<string, unknown>,
      { fetchImpl, home },
    );
    expect((calls[0]!.body.params.arguments as { harness: string }).harness).toBe("cowork");
  });

  test("cloud-call core preserves explicit visibility", async () => {
    await writeTokens(validTokens(), home);
    const { fetchImpl, calls } = captureFetch((req) =>
      rpcShareSuccess(req.body.id, {
        thread_id: "x",
        thread_url: "https://lore/x",
      }),
    );

    await runShareSession({ transcript: "t", visibility: "public" }, { fetchImpl, home });

    expect((calls[0]!.body.params.arguments as { visibility: string }).visibility).toBe("public");
  });

  test("no tokens on disk → returns authRequiredToMcpError shape", async () => {
    const { fetchImpl, calls } = captureFetch(() => jsonResponse({}));
    const result = await runShareSession({ transcript: "t" }, { fetchImpl, home });
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: AUTH_REQUIRED_MESSAGE }],
    });
    // No fetch issued since getValidAccessToken short-circuited.
    expect(calls.length).toBe(0);
  });

  test("cloud JSON-RPC error (e.g. workspace_required) → re-throws", async () => {
    await writeTokens(validTokens(), home);
    const { fetchImpl } = captureFetch((req) =>
      jsonResponse({
        jsonrpc: "2.0",
        id: req.body.id,
        error: { code: -32602, message: "workspace_required" },
      }),
    );
    let caught: unknown;
    try {
      await runShareSession({ transcript: "t" }, { fetchImpl, home });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(AuthRequiredError);
    expect((caught as Error).message).toContain("workspace_required");
  });
});

describe("shareSessionFromDisk", () => {
  let home: string;
  let sessionsRoot: string;
  let source: CoworkSource;
  beforeEach(() => {
    home = makeTmpHome();
    sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "share-session-root-"));
    source = new CoworkSource({ sessionsRoot });
    __resetInFlightForTests();
    process.env.LORE_MCP_BASE_URL = "http://localhost:4000";
    __resetCloudBaseUrlForTests();
  });
  afterEach(() => {
    rmrf(home);
    rmrf(sessionsRoot);
    delete process.env.LORE_MCP_BASE_URL;
    __resetCloudBaseUrlForTests();
    __resetInFlightForTests();
  });

  /**
   * Stage a session layout matching the real Cowork on-disk shape:
   *   <root>/<accountId>/<orgId>/local_<sessionId>/audit.jsonl
   * When provided, mtimeMs is applied to the transcript because Cowork
   * sessions are ordered by transcript mtime.
   * Returns the staged session_id.
   */
  function stageSession(
    transcript: string,
    accountId = "account-A",
    orgId = "org-A",
    sessionId = "sess-A",
    mtimeMs?: number,
  ): string {
    const sessionDir = path.join(sessionsRoot, accountId, orgId);
    const innerDir = path.join(sessionDir, `local_${sessionId}`);
    fs.mkdirSync(innerDir, { recursive: true });
    const transcriptPath = path.join(innerDir, "audit.jsonl");
    fs.writeFileSync(transcriptPath, transcript);
    if (mtimeMs !== undefined) {
      fs.utimesSync(transcriptPath, new Date(mtimeMs), new Date(mtimeMs));
    }
    return sessionId;
  }

  function shareSessionFromDiskForTest(
    args: Parameters<typeof shareSessionFromDisk>[0],
    opts: Parameters<typeof shareSessionFromDisk>[1],
  ): ReturnType<typeof shareSessionFromDisk> {
    return shareSessionFromDisk(args, {
      copyToClipboard: async () => false,
      ...opts,
    });
  }
  test("Claude hook session id wins over the MCP process stale session env", async () => {
    await writeTokens(validTokens(), home);
    const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "share-session-claude-root-"));
    try {
      const cwd = "/Users/q/repos/lore";
      const projectDir = path.join(projectsRoot, encodeCwdToDir(cwd));
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, "stale-session.jsonl"), "stale-transcript");
      fs.writeFileSync(path.join(projectDir, "current-session.jsonl"), "current-transcript");
      const claudeSource = new ClaudeCodeSource({ projectsRoot, cwd });
      const { fetchImpl, calls } = captureFetch((req) =>
        rpcShareSuccess(req.body.id, {
          thread_id: "current-thread",
          thread_url: "https://lore/current-thread",
        }),
      );

      await shareSessionFromDiskForTest(
        { session_id: "current-session" },
        {
          fetchImpl,
          home,
          source: claudeSource,
          env: { CLAUDE_CODE_SESSION_ID: "stale-session" },
        },
      );

      expect(calls).toHaveLength(1);
      expect(calls[0]!.body.params.arguments).toEqual({
        transcript: "current-transcript",
        uploads: [],
        outputs: [],
        harness: "claudeCode",
        visibility: "workspace",
      });
    } finally {
      rmrf(projectsRoot);
    }
  });

  test("implicit Claude share fails closed before upload when the hook id is absent", async () => {
    await writeTokens(validTokens(), home);
    const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "share-session-claude-root-"));
    try {
      const cwd = "/Users/q/repos/lore";
      const projectDir = path.join(projectsRoot, encodeCwdToDir(cwd));
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, "stale-session.jsonl"), "stale-transcript");
      const claudeSource = new ClaudeCodeSource({ projectsRoot, cwd });
      const { fetchImpl, calls } = captureFetch(() => jsonResponse({}));

      await expect(
        shareSessionFromDiskForTest(
          {},
          {
            fetchImpl,
            home,
            source: claudeSource,
            env: { CLAUDE_CODE_SESSION_ID: "stale-session" },
          },
        ),
      ).rejects.toThrow("current Claude Code session id is unavailable");
      expect(calls).toHaveLength(0);
    } finally {
      rmrf(projectsRoot);
    }
  });

  test("COWORK_SESSION_ID env wins over newest-by-mtime when no arg", async () => {
    await writeTokens(validTokens(), home);
    stageSession("env-pick", "account-A", "org-env", "sess-env", 1_000);
    stageSession("newer-transcript", "account-A", "org-new", "sess-new", 2_000);

    const { fetchImpl, calls } = captureFetch((req) =>
      rpcShareSuccess(req.body.id, {
        thread_id: "x",
        thread_url: "https://lore/x",
      }),
    );
    await shareSessionFromDiskForTest(
      {},
      {
        fetchImpl,
        home,
        source,
        env: { COWORK_SESSION_ID: "sess-env" },
      },
    );
    expect((calls[0]!.body.params.arguments as { transcript: string }).transcript).toBe("env-pick");
  });

  test("explicit session_id that does not exist → throws InvalidParams", async () => {
    await writeTokens(validTokens(), home);
    stageSession("some-transcript");

    const { fetchImpl, calls } = captureFetch(() => jsonResponse({}));
    let caught: unknown;
    try {
      await shareSessionFromDiskForTest(
        { session_id: "nope" },
        { fetchImpl, home, source, env: {} },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("session not found: nope");
    expect(calls.length).toBe(0);
  });
  if (os.platform() === "darwin") {
    test("production clipboard path pipes the returned Lore URL to pbcopy", async () => {
      await writeTokens(validTokens(), home);
      stageSession("production-clipboard-transcript");
      const binDir = path.join(home, "bin");
      const captureFile = path.join(home, "pbcopy-input.txt");
      fs.mkdirSync(binDir);
      fs.writeFileSync(
        path.join(binDir, "pbcopy"),
        `#!/bin/bash\n/bin/cat > ${JSON.stringify(captureFile)}\n`,
        { mode: 0o755 },
      );
      const { fetchImpl } = captureFetch((req) =>
        rpcShareSuccess(req.body.id, {
          thread_id: "t_production_clip",
          thread_url: "https://lore/t_production_clip",
        }),
      );
      const originalPath = process.env.PATH;

      try {
        process.env.PATH = binDir;
        const result = await shareSessionFromDisk({}, { fetchImpl, home, source, env: {} });

        expect(fs.readFileSync(captureFile, "utf8")).toBe("https://lore/t_production_clip");
        expect(readPluginShareResult(result).clipboard_copied).toBe(true);
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    });
  }

  test("clipboard failures do not fail the share", async () => {
    await writeTokens(validTokens(), home);
    stageSession("clipboard-failure-transcript");
    const { fetchImpl } = captureFetch((req) =>
      rpcShareSuccess(req.body.id, {
        thread_id: "t_clip_fail",
        thread_url: "https://lore/t_clip_fail",
      }),
    );

    const result = await shareSessionFromDisk(
      {},
      {
        fetchImpl,
        home,
        source,
        env: {},
        copyToClipboard: async () => {
          throw new Error("clipboard unavailable");
        },
      },
    );

    expect(readPluginShareResult(result)).toEqual({
      thread_id: "t_clip_fail",
      thread_url: "https://lore/t_clip_fail",
      clipboard_copied: false,
    });
  });

  test("rejects an enveloped share payload that violates the shared contract", async () => {
    await writeTokens(validTokens(), home);
    stageSession("invalid-share-result-transcript");
    const copied: string[] = [];
    const { fetchImpl } = captureFetch((req) =>
      jsonResponse({
        jsonrpc: "2.0",
        id: req.body.id,
        result: textToolResult({ thread_id: "t_missing_url" }),
      }),
    );

    await expect(
      shareSessionFromDisk(
        {},
        {
          fetchImpl,
          home,
          source,
          env: {},
          copyToClipboard: async (url) => {
            copied.push(url);
            return true;
          },
        },
      ),
    ).rejects.toThrow("cloud share_session result did not match its contract");
    expect(copied).toEqual([]);
  });
});
