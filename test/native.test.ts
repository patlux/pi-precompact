import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, estimateTokens } from "@earendil-works/pi-coding-agent";
import { loadNativeCompaction } from "../src/native.ts";
import { inheritOwnFiles } from "../src/files.ts";
import { fingerprint, validateResult } from "../src/validation.ts";
import { assistant, native, result } from "./helpers.ts";

const settings = { enabled: true, reserveTokens: 100, keepRecentTokens: 10 };

test("adapter rejects an unreviewed Pi version", async () => {
  await assert.rejects(loadNativeCompaction(undefined, "1.5.0"), /1.4.0/);
});

test("canonical preparation respects omitted and replaced context", () => {
  const manager = SessionManager.inMemory();
  const omitted = manager.appendMessage({ role: "user", content: "OMIT-ME", timestamp: 1 });
  const replaced = manager.appendMessage({ role: "user", content: "OLD-CONTENT", timestamp: 2 });
  manager.appendMessage(assistant("Old response"));
  manager.appendContextEdit(omitted, null);
  manager.appendContextEdit(replaced, { content: "REPLACEMENT" });
  manager.appendMessage({ role: "user", content: "Recent " + "x".repeat(100), timestamp: 3 });
  manager.appendMessage(assistant("Recent response"));
  const preparation = native.prepareCompaction(manager.getBranch(), settings);
  assert.ok(preparation);
  const serialized = JSON.stringify([preparation.messagesToSummarize, preparation.turnPrefixMessages]);
  assert.doesNotMatch(serialized, /OMIT-ME|OLD-CONTENT/);
  assert.match(serialized, /REPLACEMENT/);
});

test("native preparation tracks nested Codemode file operations", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "Inspect files", timestamp: 1 });
  manager.appendMessage({ ...assistant(""), content: [{ type: "toolCall", id: "code-1", name: "codemode", arguments: { code: "fixture" } }] });
  manager.appendMessage({
    role: "toolResult", toolCallId: "code-1", toolName: "codemode", content: [{ type: "text", text: "done" }], isError: false, timestamp: 2,
    nestedCalls: { complete: true, calls: [
      { id: "code-1/read", name: "read", arguments: { path: "/fixture/read.ts" }, status: "ok", durationMs: 1 },
      { id: "code-1/write", name: "write", arguments: { path: "/fixture/write.ts", content: "new" }, status: "ok", durationMs: 1 },
    ] },
  });
  manager.appendMessage({ role: "user", content: "New task " + "x".repeat(100), timestamp: 3 });
  manager.appendMessage(assistant("new response"));
  const preparation = native.prepareCompaction(manager.getBranch(), settings);
  assert.ok(preparation);
  assert.ok(preparation.fileOps.read.has("/fixture/read.ts"));
  assert.ok(preparation.fileOps.written.has("/fixture/write.ts"));
});

test("own fromHook file lists survive subsequent native preparation", () => {
  const manager = SessionManager.inMemory();
  const kept = manager.appendMessage({ role: "user", content: "Retained history", timestamp: 1 });
  manager.appendCompaction("old summary", kept, 1000, { readFiles: ["/fixture/read.ts"], modifiedFiles: ["/fixture/write.ts"], backgroundCompaction: 1 }, true);
  manager.appendMessage(assistant("work"));
  manager.appendMessage({ role: "user", content: "New task " + "x".repeat(100), timestamp: 2 });
  manager.appendMessage(assistant("new response"));
  const preparation = native.prepareCompaction(manager.getBranch(), settings);
  assert.ok(preparation);
  assert.equal(preparation.fileOps.read.has("/fixture/read.ts"), false); // Pi 1.4.0 limitation
  inheritOwnFiles(preparation, manager.getBranch());
  assert.ok(preparation.fileOps.read.has("/fixture/read.ts"));
  assert.ok(preparation.fileOps.edited.has("/fixture/write.ts"));
});

test("size validation includes replayed system prompt exactly as native append does", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "system", content: "system ".repeat(3000), timestamp: 1 });
  manager.appendMessage({ role: "user", content: "Old task " + "x".repeat(1000), timestamp: 2 });
  manager.appendMessage(assistant("old response"));
  manager.appendMessage({ role: "user", content: "New task " + "x".repeat(100), timestamp: 3 });
  manager.appendMessage(assistant("new response"));
  const branch = manager.getBranch();
  const preparation = native.prepareCompaction(branch, settings);
  assert.ok(preparation);
  const snapshot = { sessionId: manager.getSessionId(), identity: "fixture", entryCount: branch.length, branchHash: fingerprint(branch), preparation };
  assert.equal(validateResult(snapshot, result(preparation), branch, 2000, 10_000), undefined);
  const accepted = validateResult(snapshot, result(preparation), branch, 20_000, 10_000);
  assert.ok(accepted);
  manager.appendCompaction(accepted.summary, accepted.firstKeptEntryId, accepted.tokensBefore, accepted.details, true);
  assert.equal(accepted.estimatedTokensAfter, manager.buildSessionProjection().messages.reduce((sum, message) => sum + estimateTokens(message), 0));
});
