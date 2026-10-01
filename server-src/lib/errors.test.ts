import { describe, test, expect } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AuthRequiredError, AUTH_REQUIRED_MESSAGE, authRequiredToMcpError } from "./errors";
import { toCallToolResult } from "../index.js";

describe("AuthRequiredError", () => {
  test("is throwable and catchable via instanceof", () => {
    let caught: unknown;
    try {
      throw new AuthRequiredError();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuthRequiredError);
    expect(caught).toBeInstanceOf(Error);
  });
});

describe("AUTH_REQUIRED_MESSAGE", () => {
  test('contains the literal substring "lore_login"', () => {
    expect(AUTH_REQUIRED_MESSAGE).toContain("lore_login");
  });
});

describe("authRequiredToMcpError", () => {
  test("returns isError: true with exactly one text content block", () => {
    const result = authRequiredToMcpError();
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe(AUTH_REQUIRED_MESSAGE);
  });

  test("round-trips unchanged through index.ts:toCallToolResult", () => {
    // The dispatcher in index.ts passes any object with a `content` (or
    // `structuredContent`) field through to the wire unchanged. The
    // auth-required error is built to take that fast path so the
    // `isError: true` flag and message reach the agent verbatim.
    const error = authRequiredToMcpError();
    const wrapped: CallToolResult = toCallToolResult(error);
    expect(wrapped).toBe(error);
  });
});
