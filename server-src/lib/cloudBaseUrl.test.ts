import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import { cloudBaseUrl, cloudMcpBaseUrl, __resetCloudBaseUrlForTests } from "./cloudBaseUrl";

const ENV_KEY = "LORE_MCP_BASE_URL";
const MCP_ENV_KEY = "LORE_MCP_PROXY_BASE_URL";
const PROD_DEFAULT = "https://mcp.lore.link";

describe("cloudBaseUrl", () => {
  let saved: string | undefined;
  let savedPluginStateDir: string | undefined;
  let tempDir: string | undefined;

  beforeEach(() => {
    saved = process.env[ENV_KEY];
    savedPluginStateDir = process.env.LORE_PLUGIN_STATE_DIR;
    tempDir = undefined;
    delete process.env[ENV_KEY];
    delete process.env[MCP_ENV_KEY];
    delete process.env.LORE_PLUGIN_STATE_DIR;
    __resetCloudBaseUrlForTests();
  });

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (saved === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = saved;
    }
    if (savedPluginStateDir === undefined) {
      delete process.env.LORE_PLUGIN_STATE_DIR;
    } else {
      process.env.LORE_PLUGIN_STATE_DIR = savedPluginStateDir;
    }
    delete process.env[MCP_ENV_KEY];
    __resetCloudBaseUrlForTests();
  });

  test("returns the production default when the env var is unset", () => {
    expect(cloudBaseUrl()).toBe(PROD_DEFAULT);
  });

  test("caches the resolved value at module load — env mutations after load do not affect it", () => {
    process.env[ENV_KEY] = "http://localhost:4000";
    __resetCloudBaseUrlForTests();
    const first = cloudBaseUrl();
    // Mutate env, but do NOT call the reset helper.
    process.env[ENV_KEY] = "http://localhost:9999";
    for (let i = 0; i < 1000; i++) {
      expect(cloudBaseUrl()).toBe(first);
    }
    expect(cloudBaseUrl()).toBe("http://localhost:4000");
  });

  test("accepts https URLs with a port", () => {
    process.env[ENV_KEY] = "https://staging.example.com:8443";
    __resetCloudBaseUrlForTests();
    expect(cloudBaseUrl()).toBe("https://staging.example.com:8443");
  });

  test("cloudMcpBaseUrl defaults to the auth/discovery base URL", () => {
    process.env[ENV_KEY] = "https://staging.example.com";
    __resetCloudBaseUrlForTests();
    expect(cloudMcpBaseUrl()).toBe("https://staging.example.com");
  });

  test("cloudMcpBaseUrl can point proxy calls at localhost without changing auth discovery", () => {
    process.env[MCP_ENV_KEY] = "http://localhost:4000";
    __resetCloudBaseUrlForTests();
    expect(cloudBaseUrl()).toBe(PROD_DEFAULT);
    expect(cloudMcpBaseUrl()).toBe("http://localhost:4000");
  });

  test("cloudMcpBaseUrl strips trailing slashes from its override", () => {
    process.env[MCP_ENV_KEY] = "http://localhost:4000///";
    __resetCloudBaseUrlForTests();
    expect(cloudMcpBaseUrl()).toBe("http://localhost:4000");
  });
});
