import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import { BackgroundCompaction } from "../src/controller.ts";
import { assistant, beforeEvent, deferred, fixture, flush, native, result } from "./helpers.ts";

for (const state of ["ready", "running"])
  test(`applies ${state} result only at threshold, preserving newer native messages`, async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    const gate = deferred<CompactionResult>();
    let calls = 0;
    const controller = new BackgroundCompaction(f.pi, {
      ...native,
      compact: async (preparation) => {
        calls++;
        return state === "ready" ? result(preparation) : gate.promise;
      },
    });
    controller.consider(f.ctx);
    assert.match(controller.status(), /^running/);
    await flush();
    assert.equal(calls, 1);
    assert.equal(
      f.manager.getBranch().some((e) => e.type === "compaction"),
      false,
    );
    const newer = {
      role: "user",
      content: [
        { type: "text", text: "Fresh instruction" },
        { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
      ],
      timestamp: 3,
    } as const;
    f.manager.appendMessage({ ...newer, content: [...newer.content] });
    const event = beforeEvent(f.ctx);
    const applying = controller.beforeCompact(event, f.ctx);
    const prepared = native.prepareCompaction(event.branchEntries.slice(0, 4), event.preparation.settings);
    assert.ok(prepared);
    gate.resolve(result(prepared));
    const accepted = await applying;
    assert.ok(accepted?.compaction);
    assert.equal(accepted.compaction.tokensBefore, event.preparation.tokensBefore);
    const c = accepted.compaction;
    f.manager.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true, c.usage);
    assert.ok(
      f.manager
        .buildSessionContext()
        .messages.some(
          (message) =>
            message.role === "user" && JSON.stringify(message.content) === JSON.stringify(newer.content),
        ),
    );
    assert.equal(
      f.manager.getBranch().filter((e) => e.type === "message" && e.message.role === "user").length,
      3,
    );
    assert.equal(calls, 1);
  });

for (const reason of ["manual", "overflow"] as const)
  test(`${reason} always uses native fallback`, async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    let signal: AbortSignal | undefined;
    const controller = new BackgroundCompaction(f.pi, {
      ...native,
      compact: async (_p, _m, _k, _h, _i, s) => {
        signal = s;
        return new Promise(() => {});
      },
    });
    controller.consider(f.ctx);
    await flush();
    assert.equal(await controller.beforeCompact(beforeEvent(f.ctx, reason), f.ctx), undefined);
    assert.equal(signal?.aborted, true);
  });

for (const change of ["edit", "model", "settings", "branch", "instructions", "disabled"] as const)
  test(`rejects cached result after ${change}`, async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    const controller = new BackgroundCompaction(f.pi, { ...native, compact: async (p) => result(p) });
    controller.consider(f.ctx);
    await flush();
    const event = beforeEvent(f.ctx);
    if (change === "edit") f.manager.appendContextEdit(f.manager.getBranch()[0].id, null);
    if (change === "model") await f.session.setModel({ ...f.model, contextWindow: 110_000 });
    if (change === "settings") f.settings.setCompactionEnabled(false);
    if (change === "branch") f.manager.branch(f.manager.getBranch()[1].id);
    if (change === "instructions") event.customInstructions = "Focus on errors";
    if (change === "disabled") controller.setEnabled(false, f.ctx);
    assert.equal(await controller.beforeCompact(event, f.ctx), undefined);
  });

test("revalidates edits made while foreground waits", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const gate = deferred<CompactionResult>();
  const event = beforeEvent(f.ctx);
  const controller = new BackgroundCompaction(f.pi, { ...native, compact: async () => gate.promise });
  controller.consider(f.ctx);
  await flush();
  const applying = controller.beforeCompact(event, f.ctx);
  f.manager.appendContextEdit(f.manager.getBranch()[0].id, null);
  gate.resolve(result(event.preparation));
  assert.equal(await applying, undefined);
});

test("foreground abort cancels even a provider that ignores abort", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const controller = new BackgroundCompaction(f.pi, {
    ...native,
    compact: async () => new Promise(() => {}),
  });
  controller.consider(f.ctx);
  await flush();
  const abort = new AbortController();
  const applying = controller.beforeCompact(beforeEvent(f.ctx, "threshold", abort.signal), f.ctx);
  abort.abort();
  assert.equal(await applying, undefined);
  assert.match(controller.status(), /cancelled/);
});

test("timeout is bounded and two failures pause further speculative work", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  let calls = 0;
  const controller = new BackgroundCompaction(
    f.pi,
    {
      ...native,
      compact: async () => {
        calls++;
        return new Promise(() => {});
      },
    },
    { startRatio: 0.85, minimumTokens: 64_000, timeoutMs: 5 },
  );
  for (let i = 0; i < 2; i++) {
    controller.consider(f.ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  controller.consider(f.ctx);
  await flush();
  assert.equal(calls, 2);
  assert.match(controller.status(), /^paused/);
  assert.equal(await controller.beforeCompact(beforeEvent(f.ctx), f.ctx), undefined);
  controller.reset(f.ctx);
  assert.match(controller.status(), /0\/2/);
});

test("late completion after reset cannot overwrite a new job", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const gate = deferred<CompactionResult>();
  let calls = 0;
  const controller = new BackgroundCompaction(f.pi, {
    ...native,
    compact: async (p) => (++calls === 1 ? gate.promise : result(p)),
  });
  controller.consider(f.ctx);
  await flush();
  controller.reset(f.ctx);
  controller.consider(f.ctx);
  await flush();
  gate.resolve({ ...result(beforeEvent(f.ctx).preparation), summary: "STALE" });
  await flush();
  const accepted = await controller.beforeCompact(beforeEvent(f.ctx), f.ctx);
  assert.ok(accepted?.compaction);
  assert.doesNotMatch(accepted.compaction.summary, /STALE/);
});

for (const caseName of ["small", "past-threshold", "oversized-result", "tail-growth"] as const)
  test(`safe budget: ${caseName}`, async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    let calls = 0;
    const controller = new BackgroundCompaction(f.pi, {
      ...native,
      compact: async (p) => {
        calls++;
        return { ...result(p), summary: caseName === "oversized-result" ? "x".repeat(400_000) : "summary" };
      },
    });
    if (caseName === "small") f.manager.appendMessage(assistant("small", 20_000));
    if (caseName === "past-threshold") f.manager.appendMessage(assistant("full", 95_000));
    controller.consider(f.ctx);
    await flush();
    if (caseName === "tail-growth")
      f.manager.appendMessage({ role: "user", content: "x".repeat(100_000), timestamp: 4 });
    assert.equal(await controller.beforeCompact(beforeEvent(f.ctx), f.ctx), undefined);
    assert.equal(calls, caseName === "small" || caseName === "past-threshold" ? 0 : 1);
  });
