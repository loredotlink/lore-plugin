import { describe, test, expect } from "bun:test";
import { tools } from "./index";

describe("tools barrel", () => {
  test("exports local, login, and cloud proxy tools", () => {
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual([
      "list_local_sessions",
      "read_local_session",
      "lore_login",
      "lore_login_resume",
      "share_session",
      "list_threads",
      "get_thread",
      "fork_thread",
      "search_threads",
    ]);
  });
});
