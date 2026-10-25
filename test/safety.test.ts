import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompactionResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BackgroundCompaction } from "../src/controller.ts";
import { beforeEvent, deferred, fixture, flush, native, result } from "./helpers.ts";

for (const caseName of ["native-disabled", "virtual-model", "insufficient-measured-input"] as const)
  test(`does not precompute for ${caseName}`, async (t) => {
    const f = await fixture();
    t.after(() => f.close());
    let calls = 0;
    const controller = new BackgroundCompaction(f.pi, {
      ...native,
      compact: async (p) => {
        calls++;
        return result(p);
      },
    });
    let ctx: ExtensionContext = f.ctx;
    if (caseName === "native-disabled") f.settings.setCompactionEnabled(false);
    if (caseName === "virtual-model") ctx = { ...f.ctx, model: { ...f.model, api: "pi-virtual" } };
    if (caseName === "insufficient-measured-input") {
      const entry = f.manager
        .getBranch()
        .findLast((candidate) => candidate.type === "message" && candidate.message.role === "assistant");
      assert.ok(entry?.type === "message" && entry.message.role === "assistant");
      entry.message.usage.input = 50_000;
      entry.message.usage.output = 29_000;
    }
    controller.consider(ctx);
    await flush();
    assert.equal(calls, 0);
  });

test("cancelled foreground signal rejects an already-ready result", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const controller = new BackgroundCompaction(f.pi, { ...native, compact: async (p) => result(p) });
  controller.consider(f.ctx);
  await flush();
  const signal = AbortSignal.abort();
  assert.equal(await controller.beforeCompact(beforeEvent(f.ctx, "threshold", signal), f.ctx), undefined);
});

test("session replacement during a wait cannot receive a previous session's checkpoint", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const gate = deferred<CompactionResult>();
  const event = beforeEvent(f.ctx);
  const controller = new BackgroundCompaction(f.pi, { ...native, compact: async () => gate.promise });
  controller.consider(f.ctx);
  await flush();
  const waiting = controller.beforeCompact(event, f.ctx);
  f.manager.newSession();
  gate.resolve(result(event.preparation));
  assert.equal(await waiting, undefined);
  assert.equal(f.manager.getBranch().length, 0);
});

test("records known discarded usage outside model context", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const usage = {
    input: 10,
    output: 3,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 13,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const controller = new BackgroundCompaction(f.pi, {
    ...native,
    compact: async (p) => ({ ...result(p), usage }),
  });
  controller.consider(f.ctx);
  await flush();
  controller.reset(f.ctx);
  const entry = f.manager.getBranch().at(-1);
  assert.ok(entry?.type === "custom" && entry.customType === "background-compaction.discarded");
  assert.doesNotMatch(
    JSON.stringify(f.manager.buildSessionContext().messages),
    /background-compaction.discarded/,
  );
});

test("a changed snapshot prefix is rejected even when its entry IDs remain unchanged", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const controller = new BackgroundCompaction(f.pi, { ...native, compact: async (p) => result(p) });
  controller.consider(f.ctx);
  await flush();
  const first = f.manager.getBranch()[0];
  assert.ok(first.type === "message" && first.message.role === "user");
  first.message.content = "Rewritten history";
  assert.equal(await controller.beforeCompact(beforeEvent(f.ctx), f.ctx), undefined);
});
