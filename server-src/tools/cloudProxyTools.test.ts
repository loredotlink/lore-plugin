import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCloudProxyTool } from "./cloudProxyTools";
import { AuthRequiredError, AUTH_REQUIRED_MESSAGE } from "../lib/errors";
import { writeTokens, type Tokens } from "../lib/auth/store";
import { __resetCloudBaseUrlForTests } from "../lib/cloudBaseUrl";
import { __resetInFlightForTests } from "../lib/auth/refresh";
import { __resetInFlightForTests as __resetDiscoveryInFlightForTests } from "../lib/auth/discovery";

function makeTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cloud-proxy-tools-test-"));
}
function rmrf(d: string) {
  fs.rmSync(d, { recursive: true, force: true });
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

describe("generated cloud proxy tools", () => {
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
  test("no tokens → auth-required result", async () => {
    const fetchImpl = (async () => jsonResponse({})) as unknown as typeof fetch;
    const result = await runCloudProxyTool("list_threads", {}, { fetchImpl, home });
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: AUTH_REQUIRED_MESSAGE }],
    });
  });

  test("non-auth cloud error re-throws", async () => {
    await writeTokens(validTokens(), home);
    const fetchImpl = (async (_: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { id: string };
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32602, message: "thread_not_found" },
      });
    }) as unknown as typeof fetch;
    let caught: unknown;
    try {
      await runCloudProxyTool("get_thread", { thread_id: "missing" }, { fetchImpl, home });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(AuthRequiredError);
    expect((caught as Error).message).toContain("thread_not_found");
  });
});
