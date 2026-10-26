import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompactionResult, SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import { BackgroundCompaction } from "../src/controller.ts";
import backgroundCompaction from "../src/index.ts";
import { beforeEvent, deferred, fixture, flush, native, result } from "./helpers.ts";

function compactEvent(compaction: CompactionResult): SessionCompactEvent {
  return {
    type: "session_compact",
    compactionEntry: {
      type: "compaction",
      id: "compaction-test",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      summary: compaction.summary,
      firstKeptEntryId: compaction.firstKeptEntryId,
      tokensBefore: compaction.tokensBefore,
      details: compaction.details,
      fromHook: true,
    },
    fromExtension: true,
    reason: "threshold",
    willRetry: false,
  };
}

test("footer data has both marks while waiting and only Pi's threshold when off", async (t) => {
  const f = await fixture([], [], "tui");
  const controller = new BackgroundCompaction(f.pi, native);
  t.after(async () => {
    controller.reset(f.ctx);
    await f.close();
  });
  controller.reset(f.ctx);
  // 100k window, 10k reserve: Pi compacts at 90%, the plugin starts at 85% of that.
  const idle = controller.footerState();
  assert.equal(idle?.state, "idle");
  assert.equal(idle?.applied, false);
  assert.equal(idle?.threshold, 0.9);
  assert.ok(Math.abs((idle?.start ?? 0) - 0.765) < 1e-9);
  assert.equal(idle?.after, undefined);
  controller.setEnabled(false, f.ctx);
  assert.equal(controller.footerState()?.state, "off");
  assert.equal(controller.footerState()?.start, undefined, "a disabled plugin has no start mark");
  assert.equal(controller.footerState()?.threshold, 0.9, "Pi still compacts");
  controller.reset({ ...f.ctx, model: { ...f.model, api: "pi-virtual" } });
  assert.equal(controller.footerState()?.state, "off");
  controller.setEnabled(true, f.ctx);
  controller.reset({ ...f.ctx, model: { ...f.model, api: "pi-virtual" } });
  assert.deepEqual(controller.footerState(), { state: "unavailable", applied: false });
  assert.equal(f.provider.state.callCount, 0);
});

test("ready carries the expected context after adoption; adoption marks applied until the next change", async (t) => {
  const f = await fixture([], [], "tui");
  const gate = deferred<CompactionResult>();
  const controller = new BackgroundCompaction(f.pi, { ...native, compact: async () => gate.promise });
  t.after(async () => {
    controller.reset(f.ctx);
    await f.close();
  });
  controller.consider(f.ctx);
  assert.equal(controller.footerState()?.state, "running");
  assert.equal(controller.footerState()?.after, undefined);
  await flush();
  gate.resolve(result(beforeEvent(f.ctx).preparation));
  await flush();
  const ready = controller.footerState();
  assert.equal(ready?.state, "ready");
  const after = ready?.after ?? 0;
  assert.ok(after > 0 && after < (ready?.threshold ?? 0), `after ${after} must fit below Pi's threshold`);
  const details = controller.details(f.ctx);
  assert.equal(details.job?.phase, "ready");
  assert.equal(typeof details.job?.estimate, "number");

  const accepted = await controller.beforeCompact(beforeEvent(f.ctx), f.ctx);
  assert.ok(accepted?.compaction);
  const notice = controller.compacted(compactEvent(accepted.compaction), f.ctx);
  assert.match(
    notice ?? "",
    /^✓ Background summary applied · no wait · \S+ → ~\S+ tokens · prepared in \d+s$/,
  );
  assert.equal(controller.footerState()?.state, "idle");
  assert.equal(controller.footerState()?.applied, true);
  assert.ok(controller.details(f.ctx).applied);
  assert.equal(f.statuses.get("precompact"), "bg compact: idle", "status text keeps the six states");

  controller.reset(f.ctx, "Model changed");
  assert.equal(controller.footerState()?.applied, false);
  assert.equal(controller.details(f.ctx).applied, undefined);
});

test("native or foreign compactions do not claim a background adoption", async (t) => {
  const f = await fixture([], [], "tui");
  const controller = new BackgroundCompaction(f.pi, native);
  t.after(async () => {
    controller.reset(f.ctx);
    await f.close();
  });
  const plain = result(beforeEvent(f.ctx).preparation);
  assert.equal(
    controller.compacted(compactEvent(plain), f.ctx),
    undefined,
    "no prepared summary was supplied",
  );
  assert.equal(
    controller.compacted(
      compactEvent({ ...plain, details: { readFiles: [], modifiedFiles: [], backgroundCompaction: 1 } }),
      f.ctx,
    ),
    undefined,
    "a marker alone does not prove this runtime supplied it",
  );
  assert.equal(controller.footerState()?.applied, false);
});

test("/precompact opens the status card only on an explicit status request", async (t) => {
  const f = await fixture([backgroundCompaction], [], "tui");
  t.after(() => f.close());
  await f.session.prompt("/precompact off");
  await f.session.prompt("/precompact on");
  await f.session.prompt("/precompact reset");
  assert.equal(f.opened.cards, 0, "state changes never open the card");
  assert.equal(f.notices.length, 3);
  await f.session.prompt("/precompact");
  await f.session.prompt("/precompact status");
  assert.equal(f.opened.cards, 2);
  assert.equal(f.notices.length, 3, "the card replaces the one-line status in the TUI");
  assert.deepEqual(f.errors, []);
});

for (const mode of ["json", "rpc"] as const)
  test(`/precompact status keeps the one-line answer in ${mode} mode`, async (t) => {
    const f = await fixture([backgroundCompaction], [], mode);
    t.after(() => f.close());
    await f.session.prompt("/precompact status");
    assert.equal(f.opened.cards, 0);
    assert.match(f.notices.at(-1) ?? "", /^idle: Waiting for enough context \(0\/2 failures\)$/);
    assert.deepEqual(f.widgetKeys, [], "no footer decoration outside the TUI");
  });
