import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { FOOTER_ENV } from "../src/config.ts";
import type { FooterState } from "../src/controller.ts";
import { inlineStatus, type RevealView, STATUS_KEY } from "../src/footer.ts";
import precompact from "../src/index.ts";
import { fixture } from "./helpers.ts";

const native = FooterComponent.prototype.render;
// Node's stripVTControlCharacters does not know SGR parameters with colons, so strip those first.
/** A regular expression in which ⎋ stands for ESC; Biome rejects control characters in literals. */
const sgr = (source: string, flags = "") => new RegExp(source.replaceAll("⎋", "\u001b"), flags);
const plain = (line: string) => stripVTControlCharacters(line.replace(sgr("⎋\\[[\\d:;]*m", "g"), ""));
const marks = { start: 0.765, threshold: 0.9 };
const at = (elapsed: number): RevealView => ({ phase: () => elapsed });
// SGR 4, then the colon form of SGR 58; SGR 24 and 59 close both.
const UNDERLINED = sgr("⎋\\[4m⎋\\[58:(?:2::\\d+:\\d+:\\d+|5:\\d+)m(.*?)⎋\\[24m⎋\\[59m");

function underlined(line: string): string | undefined {
  const match = UNDERLINED.exec(line);
  return match ? plain(match[1] ?? "") : undefined;
}

function withFooterEnv(value: string | undefined, t: { after: (fn: () => void) => void }) {
  const previous = process.env[FOOTER_ENV];
  if (value === undefined) delete process.env[FOOTER_ENV];
  else process.env[FOOTER_ENV] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[FOOTER_ENV];
    else process.env[FOOTER_ENV] = previous;
  });
}

test('TUI: config { "footer": "underline" } underlines Pi\'s segment instead of drawing the bar', async (t) => {
  withFooterEnv(undefined, t);
  const f = await fixture([precompact], [], "tui", { config: { footer: "underline" } });
  t.after(() => f.close());
  const before = native.call(f.footer, 160);
  const lines = f.footer.render(160);
  assert.equal(lines.length, 2, "Pi's status row disappears as with the bar");
  assert.equal(lines[0], before[0]);
  const text = plain(lines[1] ?? "");
  assert.equal(text, plain(before[1] ?? ""), "idle adds no column: the text is Pi's own");
  assert.doesNotMatch(text, /[━─│]/);
  // 79% of the 17 columns of "79.0%/100k (auto)".
  assert.equal(underlined(lines[1] ?? ""), "79.0%/100k (a");
  const warning = sgr("^⎋\\[[\\d;]+m").exec(f.ctx.ui.theme.fg("warning", "x"))?.[0];
  assert.ok(warning && lines[1]?.includes(`${warning}79.0%`), "Pi's warning colour stays on the segment");
  for (let width = 1; width <= 200; width++) {
    for (const line of f.footer.render(width)) assert.ok(visibleWidth(line) <= width, `overflow at ${width}`);
  }
  assert.equal(underlined(f.footer.render(60)[1] ?? ""), "79.0%/100k (a", "no column minimum");
  assert.deepEqual(f.notices, []);
  assert.deepEqual(f.errors, []);
});

test("underline: the state picks the colour and the suffix; ? has no underline", async (t) => {
  const f = await fixture([], [], "tui");
  t.after(() => f.close());
  const theme = f.ctx.ui.theme;
  const color = (token: "muted" | "accent" | "success" | "warning" | "dim") => {
    // The same colour as the foreground, in the terminal's mode: truecolor or 256 colours (CI).
    const ansi = theme.fg(token, "x");
    const rgb = sgr("⎋\\[38;2;(\\d+);(\\d+);(\\d+)m").exec(ansi);
    if (rgb) return `\x1b[58:2::${rgb[1]}:${rgb[2]}:${rgb[3]}m`;
    const indexed = sgr("⎋\\[38;5;(\\d+)m").exec(ansi);
    assert.ok(indexed, JSON.stringify(ansi));
    return `\x1b[58:5:${indexed[1]}m`;
  };
  const cases: [FooterState, string, ReturnType<typeof color>][] = [
    [{ state: "idle", applied: false, ...marks }, "79.0%/100k (auto)", color("muted")],
    [{ state: "running", applied: false, ...marks }, "79.0%/100k (auto) pre running", color("accent")],
    [{ state: "ready", applied: false, ...marks, after: 0.14 }, "79.0%/100k (auto) → ~14%", color("success")],
    [{ state: "paused", applied: false, ...marks }, "79.0%/100k (auto) pre paused", color("warning")],
    [{ state: "idle", applied: true, ...marks }, "79.0%/100k (auto) ✓ pre", color("muted")],
    [{ state: "off", applied: false }, "79.0%/100k (auto) pre off", color("dim")],
  ];
  for (const [state, expected, underline] of cases) {
    f.statuses.set(STATUS_KEY, `precompact: ${state.state}`);
    const lines = inlineStatus(native.call(f.footer, 160), f.statuses, state, theme, 160, {
      style: "underline",
    });
    assert.equal(lines.length, 2, state.state);
    assert.match(plain(lines[1] ?? ""), new RegExp(`^↑\\S+ ${expected.replace(/[.()?~]/g, "\\$&")} {2,}\\S`));
    assert.ok(lines[1]?.includes(`\x1b[4m${underline}`), `${state.state} underline colour`);
    assert.equal(underlined(lines[1] ?? ""), "79.0%/100k (a");
  }
  f.statuses.set(STATUS_KEY, "precompact: idle");
  const idle: FooterState = { state: "idle", applied: false, ...marks };
  const unknown = native.call(f.footer, 160).map((line) => line.replace("79.0%", "?"));
  const lines = inlineStatus(unknown, f.statuses, idle, theme, 160, { style: "underline" });
  assert.match(plain(lines[1] ?? ""), /^↑\S+ \?\/100k \(auto\) {2,}\S/);
  assert.doesNotMatch(lines[1] ?? "", sgr("⎋\\[4m"), "no measured context, no underline");
});

test("underline: the fade-in grows it, and Pi's wrapping keeps it closed per line", async (t) => {
  const f = await fixture([], [], "tui");
  t.after(() => f.close());
  const theme = f.ctx.ui.theme;
  const running: FooterState = { state: "running", applied: false, ...marks };
  f.statuses.set(STATUS_KEY, "precompact: running");
  const frame = (elapsed: number) =>
    inlineStatus(native.call(f.footer, 160), f.statuses, running, theme, 160, {
      reveal: at(elapsed),
      style: "underline",
    })[1] ?? "";
  assert.equal(underlined(frame(0)), undefined, "nothing before the fill starts");
  const middle = underlined(frame(120))?.length ?? 0;
  assert.ok(middle > 0 && middle < 13, `grows: ${middle}`);
  assert.equal(underlined(frame(Infinity)), "79.0%/100k (a");
  for (const line of wrapTextWithAnsi(frame(Infinity), 12)) {
    // Pi re-opens SGR 4 on the next line and closes it at each line end; nothing turns dim or blinks.
    const opened = (line.match(sgr("⎋\\[4m", "g")) ?? []).length;
    const closed = (line.match(sgr("⎋\\[24m", "g")) ?? []).length;
    assert.ok(closed >= opened, JSON.stringify(line));
    assert.doesNotMatch(line, sgr("⎋\\[(?:[1-4];)*[25][;m]"), JSON.stringify(line));
  }
});

test(`${FOOTER_ENV} overrides the config file in both directions`, async (t) => {
  withFooterEnv("bar", t);
  const bar = await fixture([precompact], [], "tui", { config: { footer: "underline" } });
  t.after(() => bar.close());
  assert.match(plain(bar.footer.render(160)[1] ?? ""), /│─{3} 79\.0%\/100k \(auto\)/);
  process.env[FOOTER_ENV] = "underline";
  const underline = await fixture([precompact], [], "tui");
  t.after(() => underline.close());
  assert.equal(underlined(underline.footer.render(160)[1] ?? ""), "79.0%/100k (a");
});

test("an invalid footer in the config keeps the bar and warns once", async (t) => {
  withFooterEnv(undefined, t);
  const f = await fixture([precompact], [], "tui", { config: { footer: "dots" } });
  t.after(() => f.close());
  assert.match(plain(f.footer.render(160)[1] ?? ""), /│─{3} 79\.0%\/100k \(auto\)/);
  const warnings = f.notices.filter((notice) => notice.startsWith("pi-precompact config:"));
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0] ?? "",
    /precompact\.json: "footer" must be one of bar, short, block, text, underline/,
  );
});
