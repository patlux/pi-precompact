import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { FooterComponent, SessionManager } from "@earendil-works/pi-coding-agent";
import { rgbColor, visibleWidth } from "@earendil-works/pi-tui";
import type { FooterState } from "../src/controller.ts";
import {
  hasMeasuredUsage,
  inlineStatus,
  REVEAL_MS,
  Reveal,
  type RevealView,
  STATUS_KEY,
} from "../src/footer.ts";
import backgroundCompaction from "../src/index.ts";
import { assistant, fixture } from "./helpers.ts";

const native = FooterComponent.prototype.render;
const idle: FooterState = { state: "idle", applied: false, start: 0.765, threshold: 0.9 };
const at = (elapsed: number, background?: ReturnType<typeof rgbColor>): RevealView => ({
  phase: () => elapsed,
  background,
});

/** The 26 columns of the bar in a 160-column statistics line that starts with "↑79k ". */
function barColumns(line: string): string {
  const text = plain(line);
  const start = text.indexOf(" ") + 1;
  return text.slice(start, start + 26);
}

test("measured usage means an assistant response with tokens", () => {
  const session = SessionManager.inMemory();
  session.appendMessage({ role: "user", content: "hi", timestamp: 1 });
  assert.equal(hasMeasuredUsage(session.getEntries()), false);
  session.appendMessage({
    ...assistant("empty"),
    usage: { ...assistant("").usage, input: 0, totalTokens: 0 },
  });
  assert.equal(hasMeasuredUsage(session.getEntries()), false);
  session.appendMessage(assistant("Hi", 202));
  assert.equal(hasMeasuredUsage(session.getEntries()), true);
});

test("Reveal stays hidden until a measured response, then animates once and settles", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let clock = 1_000;
  let renders = 0;
  const session = SessionManager.inMemory();
  const reveal = new Reveal(
    session,
    true,
    () => renders++,
    () => clock,
  );
  assert.equal(reveal.pending, true);
  assert.equal(reveal.phase("k"), undefined);
  session.appendMessage({ role: "user", content: "hi", timestamp: 1 });
  assert.equal(reveal.phase("k"), undefined, "a prompt alone is not measured");
  session.appendMessage(assistant("Hi", 202));
  assert.equal(reveal.phase("k"), 0, "the first measured render is frame 0");
  t.mock.timers.tick(40);
  clock += 40;
  assert.equal(renders, 1, "a frame every 40 ms");
  assert.equal(reveal.phase("k"), 40);
  clock += REVEAL_MS;
  t.mock.timers.tick(REVEAL_MS);
  assert.equal(reveal.phase("k"), Infinity);
  const after = renders;
  t.mock.timers.tick(400);
  assert.equal(renders, after, "the timer stops after the animation");
  session.appendMessage(assistant("Again", 300));
  assert.equal(reveal.phase("k"), Infinity, "only once per session");
});

test("Reveal ends early on a new key, skips motion when off, and shows existing sessions at once", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let clock = 0;
  const fresh = SessionManager.inMemory();
  const interrupted = new Reveal(
    fresh,
    true,
    () => {},
    () => clock,
  );
  fresh.appendMessage(assistant("Hi", 202));
  assert.equal(interrupted.phase("160|idle"), 0);
  clock = 40;
  assert.equal(interrupted.phase("120|idle"), Infinity, "a width change ends the animation");

  const still = SessionManager.inMemory();
  const noMotion = new Reveal(
    still,
    false,
    () => assert.fail("no frames without motion"),
    () => clock,
  );
  assert.equal(noMotion.pending, false);
  still.appendMessage(assistant("Hi", 202));
  assert.equal(noMotion.phase("k"), Infinity);

  const resumed = SessionManager.inMemory();
  resumed.appendMessage(assistant("Earlier", 5_000));
  const existing = new Reveal(
    resumed,
    true,
    () => assert.fail("no frames for an existing session"),
    () => clock,
  );
  assert.equal(existing.pending, false);
  assert.equal(existing.phase("k"), Infinity);
});

test("frames: the wave runs left to right, the fill grows, Pi's text stays put", async (t) => {
  const f = await fixture([], [], "tui");
  t.after(() => f.close());
  const theme = f.ctx.ui.theme;
  f.statuses.set(STATUS_KEY, "bg compact: idle");
  const lines = native.call(f.footer, 160);
  const frame = (elapsed: number, background?: ReturnType<typeof rgbColor>) =>
    inlineStatus(lines, f.statuses, idle, theme, 160, at(elapsed, background))[1] ?? "";
  const final = frame(Infinity);
  for (const elapsed of [0, 40, 80, 120, 160, 200, 240]) {
    const line = frame(elapsed);
    assert.equal(visibleWidth(line), visibleWidth(final), `${elapsed} ms keeps the width`);
    assert.equal(
      plain(line).replace(/[━─│]/g, " "),
      plain(final).replace(/[━─│]/g, " "),
      "only bar glyphs differ",
    );
  }
  assert.equal(barColumns(frame(0)), " ".repeat(26), "frame 0 reserves the space");
  assert.match(barColumns(frame(40)), /^─{2,} +$/, "the wave enters from the left; the fill has not started");
  assert.match(barColumns(frame(120)), /^━+─+│/, "fill and the start mark are visible");
  assert.equal(barColumns(frame(240)), barColumns(final), "the last frame is the final bar");
  const faded = frame(40, rgbColor(44, 46, 51));
  assert.notEqual(faded, frame(40), "with a known background the glyphs fade in");
  assert.equal(barColumns(faded), barColumns(frame(40)), "fading changes colours, not glyphs");
  assert.equal(frame(Infinity, rgbColor(44, 46, 51)), final);
});

test("frames: the state suffix fades in after the bar; hidden shows Pi's line unchanged", async (t) => {
  const f = await fixture([], [], "tui");
  t.after(() => f.close());
  const theme = f.ctx.ui.theme;
  const running: FooterState = { ...idle, state: "running" };
  f.statuses.set(STATUS_KEY, "bg compact: running");
  const lines = native.call(f.footer, 160);
  const frame = (elapsed: number) =>
    plain(inlineStatus(lines, f.statuses, running, theme, 160, at(elapsed))[1] ?? "");
  assert.match(frame(Infinity), /\(auto\) bg running {2,}/);
  assert.match(frame(100), /\(auto\) {12,}/, "the suffix is not there yet");
  assert.match(frame(260), /\(auto\) bg running {2,}/);
  const hidden = inlineStatus(lines, f.statuses, running, theme, 160, { phase: () => undefined });
  assert.deepEqual(hidden, [lines[0], lines[1]], "nothing from the plugin, not even the status row");
});

test("TUI: a fresh session shows nothing until the first response, then fades in once", async (t) => {
  const f = await fixture([backgroundCompaction], [], "tui", { fresh: true });
  t.after(() => f.close());
  let renders = 0;
  f.tui.requestRender = () => {
    renders++;
  };
  for (const width of [160, 99, 60]) {
    const lines = f.footer.render(width);
    assert.equal(lines.length, 2, `${width}: no status row`);
    assert.deepEqual(lines, native.call(f.footer, width).slice(0, 2), `${width}: exactly Pi's footer`);
  }
  f.manager.appendMessage({ role: "user", content: "hi", timestamp: 3 });
  assert.equal(f.footer.render(160)[1], native.call(f.footer, 160)[1], "a prompt alone shows nothing");

  f.manager.appendMessage(assistant("Hi Patrick!", 202));
  const first = f.footer.render(160);
  assert.match(plain(first[1] ?? ""), /^↑202 {27}0\.2%\/100k \(auto\)|^↑202 [━─│ ]{26} 0\.2%\/100k \(auto\)/);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(renders >= 2, `the animation requests frames (${renders})`);
  await new Promise((resolve) => setTimeout(resolve, REVEAL_MS));
  const settled = plain(f.footer.render(160)[1] ?? "");
  assert.match(settled, /^↑202 ─{18}│─{3}│─{3} 0\.2%\/100k \(auto\) {2,}/);
  const stopped = renders;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(renders, stopped, "no frames after the animation");

  await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
  await f.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
  assert.equal(plain(f.footer.render(160)[1] ?? ""), settled, "after /reload the bar is there at once");
  assert.deepEqual(f.errors, []);
});

test("TUI: PI_PRECOMPACT_MOTION=off shows the final bar with the first response", async (t) => {
  const previous = process.env.PI_PRECOMPACT_MOTION;
  process.env.PI_PRECOMPACT_MOTION = "off";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_PRECOMPACT_MOTION;
    else process.env.PI_PRECOMPACT_MOTION = previous;
  });
  const f = await fixture([backgroundCompaction], [], "tui", { fresh: true });
  t.after(() => f.close());
  f.tui.requestRender = () => assert.fail("no animation frames");
  assert.equal(f.footer.render(160).length, 2);
  f.manager.appendMessage(assistant("Hi Patrick!", 202));
  assert.match(plain(f.footer.render(160)[1] ?? ""), /^↑202 ─{18}│─{3}│─{3} 0\.2%\/100k \(auto\)/);
});
