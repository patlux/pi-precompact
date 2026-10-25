import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import { BackgroundCompaction } from "../src/controller.ts";
import backgroundCompaction from "../src/index.ts";
import { beforeEvent, deferred, fixture, flush, native, result } from "./helpers.ts";

const key = "background-compaction";

test("footer is visible from session start, follows commands, and clears on shutdown", async (t) => {
  const f = await fixture([backgroundCompaction], [], "tui");
  t.after(() => f.close());
  f.statuses.set("other-plugin", "keep me");
  assert.equal(f.statuses.get(key), "bg compact: idle");
  await f.session.prompt("/background-compaction off");
  assert.equal(f.statuses.get(key), "bg compact: off");
  await f.session.prompt("/background-compaction reset");
  assert.equal(f.statuses.get(key), "bg compact: off");
  await f.session.prompt("/background-compaction on");
  assert.equal(f.statuses.get(key), "bg compact: idle");
  await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
  assert.equal(f.statuses.has(key), false);
  assert.equal(f.statuses.get("other-plugin"), "keep me");
  assert.equal(f.provider.state.callCount, 0);
  assert.deepEqual(f.errors, []);
});

test("footer tracks running, ready, accepted and cancelled work without disappearing", async (t) => {
  const f = await fixture([], [], "tui");
  const gate = deferred<CompactionResult>();
  const controller = new BackgroundCompaction(f.pi, { ...native, compact: async () => gate.promise });
  t.after(async () => {
    controller.reset(f.ctx);
    await f.close();
  });
  controller.consider(f.ctx);
  assert.equal(f.statuses.get(key), "bg compact: running");
  await flush();
  gate.resolve(result(beforeEvent(f.ctx).preparation));
  await flush();
  assert.equal(f.statuses.get(key), "bg compact: ready");
  assert.ok((await controller.beforeCompact(beforeEvent(f.ctx), f.ctx))?.compaction);
  assert.equal(f.statuses.get(key), "bg compact: idle");
  controller.consider(f.ctx);
  controller.reset(f.ctx, "Agent aborted");
  await flush();
  assert.equal(f.statuses.get(key), "bg compact: idle");
});

test("footer shows suspension after two failures and recovers on reset", async (t) => {
  const f = await fixture([], [], "tui");
  t.after(() => f.close());
  const controller = new BackgroundCompaction(f.pi, {
    ...native,
    compact: async () => {
      throw new Error("synthetic failure");
    },
  });
  for (let i = 0; i < 2; i++) {
    controller.consider(f.ctx);
    await flush();
  }
  assert.equal(f.statuses.get(key), "bg compact: paused");
  controller.reset(f.ctx);
  assert.equal(f.statuses.get(key), "bg compact: idle");
});

test("footer distinguishes native-disabled and unsupported models from waiting", async (t) => {
  const f = await fixture([], [], "tui");
  t.after(() => f.close());
  const controller = new BackgroundCompaction(f.pi, native);
  f.settings.setCompactionEnabled(false);
  controller.reset(f.ctx);
  assert.equal(f.statuses.get(key), "bg compact: off");
  f.settings.setCompactionEnabled(true);
  controller.reset({ ...f.ctx, model: { ...f.model, api: "pi-virtual" } });
  assert.equal(f.statuses.get(key), "bg compact: unavailable");
  controller.reset(f.ctx);
  assert.equal(f.statuses.get(key), "bg compact: idle");
  assert.equal(f.provider.state.callCount, 0);
});

for (const mode of ["json", "print", "rpc"] as const)
  test(`footer does not write terminal status in ${mode} mode`, async (t) => {
    const f = await fixture([backgroundCompaction], [], mode);
    t.after(() => f.close());
    await f.session.prompt("/background-compaction off");
    assert.equal(f.statuses.size, 0);
    assert.equal(f.provider.state.callCount, 0);
  });
