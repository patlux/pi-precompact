import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { FOOTER_ENV, type FooterStyle } from "../src/config.ts";
import type { FooterState } from "../src/controller.ts";
import { decorateFooter, inlineStatus, type RevealView, STATUS_KEY } from "../src/footer.ts";
import precompact from "../src/index.ts";
import { fixture } from "./helpers.ts";

const native = FooterComponent.prototype.render;
// 100k window, 10k reserve: the plugin starts at 76.5%, Pi compacts at 90%. The fixture is at 79%.
const marks = { start: 0.765, threshold: 0.9, window: 100_000 };
const at = (elapsed: number): RevealView => ({ phase: () => elapsed });

function withoutFooterEnv(t: { after: (fn: () => void) => void }) {
  const previous = process.env[FOOTER_ENV];
  delete process.env[FOOTER_ENV];
  t.after(() => {
    if (previous !== undefined) process.env[FOOTER_ENV] = previous;
  });
}

async function styled(t: { after: (fn: () => Promise<void>) => void }) {
  const f = await fixture([], [], "tui");
  t.after(() => f.close());
  /** The statistics line for `state`, optionally with Pi's context value replaced. */
  const line = (
    style: FooterStyle,
    state: FooterState,
    options: { percent?: string; width?: number; now?: number; reveal?: RevealView } = {},
  ) => {
    f.statuses.set(STATUS_KEY, `precompact: ${state.state}`);
    const width = options.width ?? 160;
    const lines = native
      .call(f.footer, width)
      .map((text) => text.replace("79.0%", options.percent ?? "79.0%"));
    return (
      inlineStatus(lines, f.statuses, state, f.ctx.ui.theme, width, {
        style,
        now: options.now,
        reveal: options.reveal,
      })[1] ?? ""
    );
  };
  return { f, line };
}

test('TUI: config { "footer": "short" } draws an 8-cell bar with both marks', async (t) => {
  withoutFooterEnv(t);
  const f = await fixture([precompact], [], "tui", { config: { footer: "short" } });
  t.after(() => f.close());
  const lines = f.footer.render(160);
  assert.equal(lines.length, 2);
  // 79% of 8 cells: 6 filled; the start mark sits in cell 6, Pi's threshold in cell 7.
  assert.match(plain(lines[1] ?? ""), /^↑\S+ ━{6}│─│─ 79\.0%\/100k \(auto\) {2,}\S/);
  assert.match(plain(f.footer.render(80)[1] ?? ""), /━{6}│─│─ 79\.0%/, "fits from 80 columns");
  assert.match(plain(f.footer.render(79)[1] ?? ""), /79\.0%\/100k \(auto\) pre: idle/, "compact form below");
  for (let width = 1; width <= 200; width++) {
    for (const line of f.footer.render(width)) assert.ok(visibleWidth(line) <= width, `overflow at ${width}`);
  }
  assert.deepEqual(f.errors, []);
});

test("short: the fill takes the state colour; the suffix is the bar's", async (t) => {
  const { f, line } = await styled(t);
  const theme = f.ctx.ui.theme;
  const running = line("short", { state: "running", applied: false, ...marks });
  assert.match(plain(running), / 79\.0%\/100k \(auto\) pre running {2,}/);
  assert.ok(running.includes(theme.fg("accent", "━")));
  const ready = line("short", { state: "ready", applied: false, ...marks, after: 0.14 });
  assert.match(plain(ready), / 79\.0%\/100k \(auto\) → ~14% {2,}/);
  assert.ok(ready.includes(theme.fg("success", "━")));
});

test("block: one glyph that is full at Pi's threshold, in the state colour", async (t) => {
  const { f, line } = await styled(t);
  const theme = f.ctx.ui.theme;
  const idle: FooterState = { state: "idle", applied: false, ...marks };
  // 79% of a 90% threshold is 0.88 of the way: the seventh of eight steps.
  assert.match(plain(line("block", idle)), /^↑\S+ ▇ 79\.0%\/100k \(auto\) {2,}\S/);
  assert.ok(line("block", idle).includes(theme.fg("muted", "▇")));
  assert.match(plain(line("block", idle, { percent: "40.0%" })), / ▄ 40\.0%/);
  assert.match(plain(line("block", idle, { percent: "89.9%" })), / ▇ 89\.9%/, "not full below the threshold");
  assert.match(plain(line("block", idle, { percent: "90.0%" })), / █ 90\.0%/, "full from the threshold on");
  assert.match(plain(line("block", idle, { percent: "95.0%" })), / █ 95\.0%/);
  assert.match(
    plain(line("block", idle, { percent: "?" })),
    / ▁ \?\/100k/,
    "lowest step before a measurement",
  );
  const running = line("block", { state: "running", applied: false, ...marks });
  assert.ok(running.includes(theme.fg("accent", "▇")));
  assert.match(plain(running), / ▇ 79\.0%\/100k \(auto\) pre running {2,}/);
  assert.match(plain(line("block", idle, { width: 50 })), /▇ 79\.0%/, "no column minimum");
  assert.match(plain(line("block", idle, { reveal: at(0) })), /^↑\S+ {3}79\.0%/, "the glyph fades in");
});

test("text: tokens left until the start while idle, the running time while running", async (t) => {
  const { line } = await styled(t);
  const idle: FooterState = { state: "idle", applied: false, ...marks };
  // (76.5% - 40%) of 100k = 36.5k tokens.
  assert.match(
    plain(line("text", idle, { percent: "40.0%" })),
    /^↑\S+ 40\.0%\/100k \(auto\) pre in 37k {2,}\S/,
  );
  assert.match(
    plain(line("text", idle)),
    /^↑\S+ 79\.0%\/100k \(auto\) {2,}\S/,
    "past the start: nothing to count",
  );
  assert.doesNotMatch(plain(line("text", idle, { percent: "?" })), /pre/);
  assert.doesNotMatch(plain(line("text", { ...idle, window: undefined }, { percent: "40.0%" })), /pre in/);
  const now = 1_000_000;
  const running = (ms: number) =>
    plain(line("text", { state: "running", applied: false, ...marks, runningSince: now - ms }, { now }));
  assert.match(running(42_900), / 79\.0%\/100k \(auto\) pre running 42s {2,}/, "whole seconds, rounded down");
  assert.match(running(125_000), / pre running 2:05 {2,}/);
  assert.match(plain(line("text", { state: "running", applied: false, ...marks })), / pre running {2,}/);
  assert.match(
    plain(line("text", { state: "ready", applied: false, ...marks, after: 0.14 })),
    / → ~14% {2,}/,
  );
  assert.match(plain(line("text", { state: "idle", applied: true, ...marks })), / ✓ pre {2,}/);
  assert.match(plain(line("text", { state: "paused", applied: false, ...marks })), / pre paused {2,}/);
  assert.doesNotMatch(plain(line("text", idle)), /[━─│▁-█]/, "no bar at all");
});

test("text: a running state asks for the render of the next second; others do not", async (t) => {
  const f = await fixture([], [], "tui");
  t.after(() => f.close());
  let state: FooterState = { state: "running", applied: false, ...marks, runningSince: Date.now() - 1_250 };
  f.statuses.set(STATUS_KEY, "precompact: running");
  const delays: number[] = [];
  const undo = decorateFooter(f.footer, f.ctx.ui.theme, () => state, {
    style: "text",
    tick: (ms) => delays.push(ms),
  });
  t.after(undo);
  assert.match(plain(f.footer.render(160)[1] ?? ""), / pre running 1s/);
  assert.equal(delays.length, 1);
  assert.ok((delays[0] ?? 0) > 0 && (delays[0] ?? 0) <= 1000, `delay ${delays[0]}`);
  state = { state: "ready", applied: false, ...marks };
  f.statuses.set(STATUS_KEY, "precompact: ready");
  f.footer.render(160);
  assert.equal(delays.length, 1, "the clock stops with the running state");
  undo();
  const bar = decorateFooter(
    f.footer,
    f.ctx.ui.theme,
    () => ({ ...state, state: "running", runningSince: 0 }),
    {
      tick: (ms) => delays.push(ms),
    },
  );
  f.statuses.set(STATUS_KEY, "precompact: running");
  f.footer.render(160);
  bar();
  assert.equal(delays.length, 1, "the bar shows no time and needs no clock");
});
