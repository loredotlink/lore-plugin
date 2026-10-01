import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CoworkSource } from "./cowork.js";
import type { SessionSummary } from "./index.js";

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cowork-source-test-"));
}

function stageSession(
  root: string,
  accountId: string,
  orgId: string,
  sessionId: string,
  mtimeMs: number,
): string {
  const sessionDir = path.join(root, accountId, orgId);
  const localDir = path.join(sessionDir, `local_${sessionId}`);
  fs.mkdirSync(localDir, { recursive: true });
  const transcriptPath = path.join(localDir, "audit.jsonl");
  fs.writeFileSync(transcriptPath, "{}\n");
  fs.utimesSync(transcriptPath, new Date(mtimeMs), new Date(mtimeMs));
  return sessionDir;
}

test("resolveActive: trims whitespace from COWORK_SESSION_ID", () => {
  const root = makeTmpRoot();
  stageSession(root, "account-A", "org-target", "sess-target", 1_000);

  const source = new CoworkSource({ sessionsRoot: root });
  expect(source.resolveActive({ COWORK_SESSION_ID: "  sess-target  " }).sessionId).toBe(
    "sess-target",
  );
});

test("resolveActive: blank COWORK_SESSION_ID is ignored", () => {
  const root = makeTmpRoot();
  stageSession(root, "account-A", "org-newest", "sess-newest", 9_000);

  const source = new CoworkSource({ sessionsRoot: root });
  expect(source.resolveActive({ COWORK_SESSION_ID: "   " }).sessionId).toBe("sess-newest");
});

test("resolveActive: throws when no sessions on disk", () => {
  const source = new CoworkSource({ sessionsRoot: "/tmp/definitely-empty-xyz" });
  expect(() => source.resolveActive({})).toThrow(/no Cowork session/);
});

function stageFullSession(
  root: string,
  accountId: string,
  orgId: string,
  sessionId: string,
  opts: {
    transcript?: string;
    transcriptName?: "audit.jsonl" | "transcript.jsonl";
    uploads?: string[];
    outputs?: string[];
    localSubdir?: string;
  } = {},
): SessionSummary {
  const sessionDir = path.join(root, accountId, orgId);
  const localDir = path.join(sessionDir, opts.localSubdir ?? `local_${sessionId}`);
  fs.mkdirSync(localDir, { recursive: true });
  if (opts.transcript !== undefined) {
    fs.writeFileSync(path.join(localDir, opts.transcriptName ?? "audit.jsonl"), opts.transcript);
  }
  for (const name of opts.uploads ?? []) {
    fs.mkdirSync(path.join(localDir, "uploads"), { recursive: true });
    fs.writeFileSync(path.join(localDir, "uploads", name), "x");
  }
  for (const name of opts.outputs ?? []) {
    fs.mkdirSync(path.join(localDir, "outputs"), { recursive: true });
    fs.writeFileSync(path.join(localDir, "outputs", name), "x");
  }
  const stat = fs.statSync(sessionDir);
  return {
    sessionId,
    accountId,
    orgId,
    sessionDir,
    mtimeMs: stat.mtimeMs,
  };
}

test("readSession: throws when session has no local_* subdirectory", () => {
  const root = makeTmpRoot();
  const sessionDir = path.join(root, "account-A", "org-A");
  fs.mkdirSync(sessionDir, { recursive: true });
  const summary: SessionSummary = {
    sessionId: "sess-A",
    accountId: "account-A",
    orgId: "org-A",
    sessionDir,
    mtimeMs: fs.statSync(sessionDir).mtimeMs,
  };

  const source = new CoworkSource({ sessionsRoot: root });
  expect(() => source.readSession(summary)).toThrow(/local_\* subdirectory/);
});

test("readSession: throws when local_* subdir has no transcript", () => {
  const root = makeTmpRoot();
  const summary = stageFullSession(root, "account-A", "org-A", "sess-A", {});

  const source = new CoworkSource({ sessionsRoot: root });
  expect(() => source.readSession(summary)).toThrow(/transcript file/);
});

test("readSession: picks the local_* subdir with newest transcript mtime", () => {
  const root = makeTmpRoot();
  const sessionDir = path.join(root, "account-A", "org-A");
  fs.mkdirSync(path.join(sessionDir, "local_old"), { recursive: true });
  fs.mkdirSync(path.join(sessionDir, "local_new"), { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "local_old", "audit.jsonl"), "OLD\n");
  fs.writeFileSync(path.join(sessionDir, "local_new", "audit.jsonl"), "NEW\n");
  fs.utimesSync(
    path.join(sessionDir, "local_old", "audit.jsonl"),
    new Date(1_000),
    new Date(1_000),
  );
  fs.utimesSync(
    path.join(sessionDir, "local_new", "audit.jsonl"),
    new Date(9_000),
    new Date(9_000),
  );

  const summary: SessionSummary = {
    sessionId: "sess-A",
    accountId: "account-A",
    orgId: "org-A",
    sessionDir,
    mtimeMs: fs.statSync(sessionDir).mtimeMs,
  };
  const source = new CoworkSource({ sessionsRoot: root });
  expect(source.readSession(summary).transcript).toBe("NEW\n");
});
