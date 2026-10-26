import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { type ExtensionFactory, FooterComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FooterState } from "../src/controller.ts";
import { findBuiltInFooter, inlineStatus, STATUS_KEY } from "../src/footer.ts";
import precompact from "../src/index.ts";
import { fixture } from "./helpers.ts";

const native = FooterComponent.prototype.render;
const MARK = Symbol.for("pi-precompact.footer-render");
const marks = { start: 0.765, threshold: 0.9 };

function markedOriginal(render: unknown): unknown {
  if (typeof render !== "function") return undefined;
  const mark: unknown = Reflect.get(render, MARK);
  return typeof mark === "object" && mark !== null ? Reflect.get(mark, "original") : undefined;
}

/** Mimics pi-session-id-footer: decorates only the first line of the same footer instance. */
const firstLineDecorator: ExtensionFactory = (pi) => {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget(
      "other-footer",
      (tui) => {
        const footer = findBuiltInFooter(tui.children);
        assert.ok(footer);
        const previous = footer.render;
        let active = true;
        const render = function (this: FooterComponent, width: number): string[] {
          const lines = previous.call(this, width);
          if (!active) return lines;
          return [`${truncateToWidth(lines[0] ?? "", width - 6, "")} OTHER`, ...lines.slice(1)];
        };
        footer.render = render;
        return {
          render: () => [],
          invalidate() {},
          dispose() {
            active = false;
            if (footer.render === render) footer.render = previous;
          },
        };
      },
      { placement: "belowEditor" },
    );
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setWidget("other-footer", undefined);
  });
};

test("TUI: the bar appears beside Pi's unchanged context segment without a status row", async (t) => {
  const f = await fixture([precompact], [], "tui");
  t.after(() => f.close());
  assert.deepEqual(f.widgetKeys, ["precompact-footer"]);
  assert.deepEqual(f.widgets.get("precompact-footer")?.render(160), [], "zero-row widget");
  const before = native.call(f.footer, 160);
  assert.equal(before.length, 3);
  assert.equal(plain(before[2] ?? ""), "precompact: idle");
  const lines = f.footer.render(160);
  assert.equal(lines.length, 2, "Pi's status row disappears when it only held this plugin");
  assert.equal(lines[0], before[0]);
  // 79% of 100k; the plugin starts at 76.5% (cell 18), Pi compacts at 90% (cell 21).
  assert.match(plain(lines[1] ?? ""), /^↑\S+ ━{18}│━─{2}│─{3} 79\.0%\/100k \(auto\) {2,}\S/);
  const stats = before[1] ?? "";
  const at = stats.indexOf("79.0%/100k (auto)");
  const segment = stats.slice(stats.lastIndexOf("\u001b[", at), at + "79.0%/100k (auto)".length);
  assert.ok(
    segment && lines[1]?.includes(segment),
    "Pi's segment and its warning colour are byte-for-byte unchanged",
  );
  for (let width = 1; width <= 200; width++) {
    for (const line of f.footer.render(width)) assert.ok(visibleWidth(line) <= width, `overflow at ${width}`);
  }
  assert.match(
    plain(f.footer.render(99)[1] ?? ""),
    /79\.0%\/100k \(auto\) pre: idle {2,}/,
    "compact form below 100",
  );
  assert.doesNotMatch(plain(f.footer.render(99)[1] ?? ""), /━/);
  const narrow = f.footer.render(30);
  assert.equal(plain(narrow.at(-1) ?? ""), "precompact: idle", "Pi's status row is the fallback");
  assert.deepEqual(f.errors, []);
});

test("other statuses keep Pi's status row; only this plugin's entry moves", async (t) => {
  const f = await fixture([precompact], [], "tui");
  t.after(() => f.close());
  f.statuses.set("goal", "working\n now");
  const lines = f.footer.render(160);
  assert.equal(lines.length, 3);
  assert.equal(plain(lines[2] ?? ""), "working now");
  assert.match(plain(lines[1] ?? ""), /│─{3} 79\.0%\/100k \(auto\)/);
  assert.deepEqual(
    [...f.statuses.keys()].sort(),
    [STATUS_KEY, "goal"].sort(),
    "shared statuses are never modified",
  );
});

test("each state adds its own suffix and colour; Pi's text stays in place", async (t) => {
  const f = await fixture([], [], "tui");
  t.after(() => f.close());
  const theme = f.ctx.ui.theme;
  const cases: [FooterState, RegExp, string | undefined][] = [
    [
      { state: "running", applied: false, ...marks },
      / 79\.0%\/100k \(auto\) pre running {2,}/,
      theme.fg("accent", "━"),
    ],
    [
      { state: "ready", applied: false, ...marks, after: 0.14 },
      / 79\.0%\/100k \(auto\) → ~14% {2,}/,
      theme.fg("success", "━"),
    ],
    [
      { state: "ready", applied: false, ...marks },
      / 79\.0%\/100k \(auto\) pre ready {2,}/,
      theme.fg("success", "━"),
    ],
    [
      { state: "paused", applied: false, ...marks },
      / 79\.0%\/100k \(auto\) pre paused {2,}/,
      theme.fg("warning", "━"),
    ],
    [{ state: "idle", applied: true, ...marks }, / 79\.0%\/100k \(auto\) ✓ pre {2,}/, theme.fg("muted", "━")],
    [
      { state: "off", applied: false, threshold: 0.9 },
      /━{19}─{2}│─{3} 79\.0%\/100k \(auto\) pre off {2,}/,
      undefined,
    ],
    [
      { state: "unavailable", applied: false },
      /━{19}─{5} 79\.0%\/100k \(auto\) pre unavailable {2,}/,
      undefined,
    ],
  ];
  for (const [state, expected, fill] of cases) {
    f.statuses.set(STATUS_KEY, `precompact: ${state.state}`);
    const lines = inlineStatus(native.call(f.footer, 160), f.statuses, state, theme, 160);
    assert.equal(lines.length, 2, state.state);
    assert.match(plain(lines[1] ?? ""), expected, JSON.stringify(state));
    if (fill) assert.ok(lines[1]?.includes(fill), `${state.state} fill colour`);
    if (state.after !== undefined) assert.ok(lines[1]?.includes(theme.fg("success", "~14%")));
  }
  f.statuses.set(STATUS_KEY, "precompact: idle");
  const lines = native.call(f.footer, 160);
  const ready: FooterState = { state: "ready", applied: false, ...marks, after: 0.14 };
  assert.deepEqual(
    inlineStatus(lines, f.statuses, ready, theme, 160),
    lines,
    "state and status text disagree",
  );
  assert.deepEqual(
    inlineStatus([...lines, "x"], f.statuses, ready, theme, 160),
    [...lines, "x"],
    "unknown layout",
  );
  const changed = [lines[0] ?? "", "new stats format", lines[2] ?? ""];
  assert.deepEqual(
    inlineStatus(changed, f.statuses, ready, theme, 160),
    changed,
    "unknown statistics format",
  );
  assert.deepEqual(inlineStatus(lines, f.statuses, undefined, theme, 160), lines, "no state yet");
});

for (const order of ["plugin first", "other decorator first"] as const)
  test(`composes with another footer decorator (${order}) and survives reloads`, async (t) => {
    const extensions =
      order === "plugin first" ? [precompact, firstLineDecorator] : [firstLineDecorator, precompact];
    const f = await fixture(extensions, [], "tui");
    t.after(() => f.close());
    for (let round = 0; round < 3; round++) {
      if (round > 0) {
        await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
        await f.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
      }
      const lines = f.footer.render(160).map(plain);
      assert.equal(lines.length, 2, `round ${round}`);
      assert.equal(lines[0]?.match(/ OTHER$/g)?.length, 1, "the other decorator keeps its first line");
      assert.equal(lines[1]?.match(/│/g)?.length, 2, "exactly one bar");
      if (order === "plugin first") {
        // Our wrapper sits below the other one. On reload it must not pile up inactive copies.
        const ours = Reflect.get(f.footer, "render");
        assert.equal(markedOriginal(ours), undefined, "the other decorator is on top");
      } else {
        assert.equal(typeof markedOriginal(f.footer.render), "function", "our wrapper is on top");
      }
    }
    assert.deepEqual(f.errors, []);
  });

test("reloads below another decorator never stack inactive wrappers", async (t) => {
  let previous: unknown;
  const recorder: ExtensionFactory = (pi) => {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.setWidget("recorder", (tui) => {
        const footer = findBuiltInFooter(tui.children);
        assert.ok(footer);
        previous = footer.render;
        const own = footer.render;
        const render = function (this: FooterComponent, width: number) {
          return own.call(this, width);
        };
        footer.render = render;
        return {
          render: () => [],
          invalidate() {},
          dispose() {
            if (footer.render === render) footer.render = own;
          },
        };
      });
    });
    pi.on("session_shutdown", (_event, ctx) => ctx.ui.setWidget("recorder", undefined));
  };
  const f = await fixture([precompact, recorder], [], "tui");
  t.after(() => f.close());
  for (let round = 0; round < 3; round++) {
    if (round > 0) {
      await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
      await f.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
    }
    // The recorder wraps our wrapper; ours must wrap Pi's method directly every time.
    assert.equal(markedOriginal(previous), native, `round ${round}`);
  }
});

test("shutdown restores Pi's render method and removes the widget", async (t) => {
  const f = await fixture([precompact], [], "tui");
  t.after(() => f.close());
  assert.notEqual(f.footer.render, native);
  await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  assert.equal(f.footer.render, native);
  assert.equal(f.widgets.has("precompact-footer"), false);
  assert.deepEqual(f.footer.render(160), native.call(f.footer, 160));
  assert.equal(f.statuses.has(STATUS_KEY), false);
});

test("a custom footer is left alone; Pi's status row stays the fallback", async (t) => {
  const f = await fixture([precompact], [], "tui");
  t.after(() => f.close());
  await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
  f.footerContainer.clear();
  const custom = { render: () => ["custom footer"], invalidate() {} };
  f.footerContainer.addChild(custom);
  await f.session.extensionRunner.emit({ type: "session_start", reason: "reload" });
  assert.deepEqual(f.tui.render(80), ["custom footer"]);
  assert.equal(f.statuses.get(STATUS_KEY), "precompact: idle");
  assert.deepEqual(f.errors, []);
});
