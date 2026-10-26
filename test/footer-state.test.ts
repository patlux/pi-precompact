import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompactionResult, EventBus, SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import { BackgroundCompaction, REQUEST_CHANNEL, STATE_CHANNEL } from "../src/controller.ts";
import backgroundCompaction from "../src/index.ts";
import { beforeEvent, deferred, fixture, flush, native, result } from "./helpers.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Collects footer payloads as plain records. */
function collect(events: EventBus): Record<string, unknown>[] {
  const seen: Record<string, unknown>[] = [];
  events.on(STATE_CHANNEL, (data) => {
    assert.ok(isRecord(data) && data.version === 1, "payload must be a versioned record");
    seen.push(data);
  });
  return seen;
}

function last(seen: Record<string, unknown>[]): Record<string, unknown> {
  const value = seen.at(-1);
  assert.ok(value, "expected a footer payload");
  return value;
}

function share(value: unknown): number {
  assert.equal(typeof value, "number");
  return Number(value);
}

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

test("footer data on pi.events follows the plugin and answers late subscribers", async (t) => {
  const f = await fixture([backgroundCompaction], [], "tui");
  t.after(() => f.close());
  const seen = collect(f.events);
  f.events.emit(REQUEST_CHANNEL, undefined);
  const idle = last(seen);
  // 100k window, 10k reserve: Pi compacts at 90%, the plugin starts at 85% of that.
  assert.equal(idle.state, "idle");
  assert.equal(idle.applied, false);
  assert.equal(share(idle.threshold), 0.9);
  assert.ok(Math.abs(share(idle.start) - 0.765) < 1e-9);
  assert.equal(idle.after, undefined);
  await f.session.prompt("/background-compaction off");
  assert.equal(last(seen).state, "off");
  assert.equal(last(seen).start, undefined, "a disabled plugin has no start mark");
  assert.equal(share(last(seen).threshold), 0.9, "Pi still compacts");
  await f.session.prompt("/background-compaction on");
  assert.equal(last(seen).state, "idle");
  await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
  const count = seen.length;
  f.events.emit(REQUEST_CHANNEL, undefined);
  assert.equal(seen.length, count, "a shut-down runtime no longer answers");
  assert.equal(f.provider.state.callCount, 0);
  assert.deepEqual(f.errors, []);
});

test("ready publishes the expected context after adoption; adoption marks applied until the next change", async (t) => {
  const f = await fixture([], [], "tui");
  const gate = deferred<CompactionResult>();
  const controller = new BackgroundCompaction(f.pi, { ...native, compact: async () => gate.promise });
  t.after(async () => {
    controller.reset(f.ctx);
    await f.close();
  });
  const seen = collect(f.events);
  controller.consider(f.ctx);
  assert.equal(last(seen).state, "running");
  assert.equal(last(seen).after, undefined);
  await flush();
  gate.resolve(result(beforeEvent(f.ctx).preparation));
  await flush();
  const ready = last(seen);
  assert.equal(ready.state, "ready");
  const after = share(ready.after);
  assert.ok(after > 0 && after < share(ready.threshold), `after ${after} must fit below Pi's threshold`);
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
  assert.equal(last(seen).state, "idle");
  assert.equal(last(seen).applied, true);
  assert.ok(controller.details(f.ctx).applied);
  assert.equal(
    f.statuses.get("background-compaction"),
    "bg compact: idle",
    "status text keeps the six states",
  );

  controller.reset(f.ctx, "Model changed");
  assert.equal(last(seen).applied, false);
  assert.equal(controller.details(f.ctx).applied, undefined);
});

test("native or foreign compactions do not claim a background adoption", async (t) => {
  const f = await fixture([], [], "tui");
  const controller = new BackgroundCompaction(f.pi, native);
  t.after(async () => {
    controller.reset(f.ctx);
    await f.close();
  });
  const seen = collect(f.events);
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
  assert.equal(last(seen).applied, false);
});

test("/background-compaction opens the status card only on an explicit status request", async (t) => {
  const f = await fixture([backgroundCompaction], [], "tui");
  t.after(() => f.close());
  await f.session.prompt("/background-compaction off");
  await f.session.prompt("/background-compaction on");
  await f.session.prompt("/background-compaction reset");
  assert.equal(f.opened.cards, 0, "state changes never open the card");
  assert.equal(f.notices.length, 3);
  await f.session.prompt("/background-compaction");
  await f.session.prompt("/background-compaction status");
  assert.equal(f.opened.cards, 2);
  assert.equal(f.notices.length, 3, "the card replaces the one-line status in the TUI");
  assert.deepEqual(f.errors, []);
});

for (const mode of ["json", "rpc"] as const)
  test(`/background-compaction status keeps the one-line answer in ${mode} mode`, async (t) => {
    const f = await fixture([backgroundCompaction], [], mode);
    t.after(() => f.close());
    const seen = collect(f.events);
    await f.session.prompt("/background-compaction status");
    assert.equal(f.opened.cards, 0);
    assert.match(f.notices.at(-1) ?? "", /^idle: Waiting for enough context \(0\/2 failures\)$/);
    assert.equal(seen.length, 0, "no footer data outside the TUI");
  });
