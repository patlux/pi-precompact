import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, Type } from "@earendil-works/pi-ai";
import backgroundCompaction from "../src/index.ts";
import { assistant, beforeEvent, deferred, fixture, flush } from "./helpers.ts";

// Faux computes its own usage from text length. Inject deterministic measured
// usage through Pi's supported finalized-message hook to exercise the thresholds.
const measuredUsage: ExtensionFactory = pi => {
  pi.on("message_end", event => {
    if (event.message.role !== "assistant") return;
    const text = event.message.content.filter(block => block.type === "text").map(block => block.text).join("");
    const tokens = text === "Second live answer" || text === "Threshold answer" ? 92_000 : 79_000;
    return { message: { ...event.message, usage: assistant("", tokens).usage } };
  });
};

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("Condition did not become true");
}

test("real Pi runtime: background summary does not block a prompt and is committed only by native threshold", async t => {
  const summaryGate = deferred<ReturnType<typeof fauxAssistantMessage>>();
  const f = await fixture([measuredUsage, backgroundCompaction]); t.after(() => f.close());
  const requests: string[] = [];
  f.provider.setResponses([
    context => { requests.push(JSON.stringify(context)); return assistant("First live answer", 79_000); },
    async context => { requests.push(JSON.stringify(context)); return summaryGate.promise; },
    context => { requests.push(JSON.stringify(context)); return assistant("Second live answer", 92_000); },
  ]);
  await f.session.prompt("First live instruction");
  await waitFor(() => f.provider.state.callCount === 2);
  assert.equal(f.manager.getBranch().some(entry => entry.type === "compaction"), false);
  let settled = false;
  const secondPrompt = f.session.prompt("Keep this newer instruction").then(() => { settled = true; });
  await waitFor(() => f.provider.state.callCount === 3);
  assert.equal(settled, false);
  summaryGate.resolve(fauxAssistantMessage("Summary of the earlier work."));
  await secondPrompt;
  const compactions = f.manager.getBranch().filter(entry => entry.type === "compaction");
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].fromHook, true);
  assert.match(compactions[0].summary, /Summary of the earlier work/);
  assert.ok(compactions[0].usage);
  const visible = JSON.stringify(f.manager.buildSessionContext().messages);
  assert.match(visible, /Keep this newer instruction/);
  assert.match(visible, /Second live answer/);
  assert.doesNotMatch(requests[1], /Keep this newer instruction/);
  const userMessages = f.manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user");
  assert.equal(userMessages.length, 4); // two seeded + two actual; no synthetic continue
  assert.deepEqual(f.errors, []);
});

test("tool-driven turns continue while the summary is pending without abort or synthetic input", async t => {
  const gate = deferred<ReturnType<typeof fauxAssistantMessage>>();
  let toolCalls = 0;
  let thirdRequestReached = false;
  const tool: ExtensionFactory = pi => {
    pi.registerTool({ name: "fixture", label: "fixture", description: "In-memory test", parameters: Type.Object({}),
      execute: async () => { toolCalls++; return { content: [{ type: "text", text: "done" }], details: undefined }; },
    });
  };
  const f = await fixture([tool, measuredUsage, backgroundCompaction]); t.after(() => f.close());
  f.session.setActiveToolsByName(["fixture"]);
  f.provider.setResponses([
    fauxAssistantMessage([{ type: "toolCall", id: "fixture-1", name: "fixture", arguments: {} }], { stopReason: "toolUse" }),
    async () => gate.promise,
    () => {
      thirdRequestReached = true;
      gate.resolve(fauxAssistantMessage("Background tool-turn checkpoint"));
      return fauxAssistantMessage("Second live answer");
    },
  ]);
  await f.session.prompt("Use the fixture tool");
  assert.equal(thirdRequestReached, true);
  assert.equal(toolCalls, 1);
  assert.equal(f.provider.state.callCount, 3);
  assert.equal(f.manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user").length, 3);
  assert.ok(f.manager.getBranch().some(entry => entry.type === "compaction" && entry.fromHook));
  assert.deepEqual(f.errors, []);
});

test("real provider failure falls through to Pi's foreground summary", async t => {
  const f = await fixture([measuredUsage, backgroundCompaction]); t.after(() => f.close());
  f.provider.setResponses([
    assistant("First live answer", 79_000),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic failure" }),
    assistant("Threshold answer", 92_000),
    fauxAssistantMessage("Native fallback summary"),
  ]);
  await f.session.prompt("First live instruction");
  await waitFor(() => f.provider.state.callCount === 2);
  await flush();
  await f.session.prompt("Second live instruction");
  const compaction = f.manager.getBranch().find(entry => entry.type === "compaction");
  assert.ok(compaction);
  assert.equal(compaction.fromHook, false);
  assert.match(compaction.summary, /Native fallback summary/);
  assert.deepEqual(f.errors, []);
});

test("Pi's actual file extension loader resolves the plugin and private native adapter", async t => {
  const path = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const f = await fixture([measuredUsage], [path]); t.after(() => f.close());
  assert.ok(f.session.extensionRunner.getCommand("background-compaction"));
  assert.ok(f.session.extensionRunner.getExtensionPaths().includes(path));
  f.provider.setResponses([assistant("first", 79_000), fauxAssistantMessage("File-loaded summary")]);
  await f.session.prompt("Start");
  await waitFor(() => f.provider.state.callCount === 2);
  await flush();
  const accepted = await f.session.extensionRunner.emit(beforeEvent(f.ctx));
  assert.ok(accepted?.compaction);
  assert.match(accepted.compaction.summary, /File-loaded summary/);
  assert.deepEqual(f.errors, []);
});

test("shutdown cancels an active native summary request", async t => {
  let providerSignal: AbortSignal | undefined;
  let context: ExtensionContext | undefined;
  const capture: ExtensionFactory = pi => { pi.on("turn_end", (_event, ctx) => { context = ctx; }); };
  const f = await fixture([measuredUsage, backgroundCompaction, capture]); t.after(() => f.close());
  f.provider.setResponses([
    assistant("First answer", 79_000),
    async (_context, options) => {
      providerSignal = options?.signal;
      return new Promise(resolve => options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true }));
    },
  ]);
  await f.session.prompt("Start");
  await waitFor(() => providerSignal !== undefined);
  await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
  assert.equal(providerSignal?.aborted, true);
  assert.ok(context);
  assert.equal(await f.session.extensionRunner.emit(beforeEvent(context)), undefined);
});
