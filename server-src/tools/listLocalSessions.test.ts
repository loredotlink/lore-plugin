import { describe, test, expect } from "bun:test";
import { listLocalSessionsTool } from "./listLocalSessions";

describe("listLocalSessionsTool — shape", () => {
  test("has an empty-object input schema with additionalProperties: false", () => {
    expect(listLocalSessionsTool.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });
});
