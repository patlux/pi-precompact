import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { gauge, renderCard, statusCard } from "../src/card.ts";
import type { StatusDetails } from "../src/controller.ts";
import { fixture } from "./helpers.ts";

initTheme("dark", false);
const now = 1_000_000_000;
const usage = {
  input: 38_000,
  output: 2_900,
  cacheRead: 3_200,
  cacheWrite: 0,
  totalTokens: 44_100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0124 },
};
const ready: StatusDetails = {
  label: "ready",
  reason: "Summary held until native threshold compaction",
  failures: 0,
  enabled: true,
  context: { tokens: 60_000, window: 100_000, percent: 60 },
  start: 0.765,
  threshold: 0.9,
  job: { phase: "ready", startedAt: now - 168_000, readyAt: now - 120_000, estimate: 21_000, usage },
};

test("gauge marks start and Pi's threshold and fills by context", () => {
  const segments = gauge(60, 0.765, 0.9, "success");
  const text = segments.map(([part]) => part).join("");
  assert.equal(text.length, 26, "24 cells plus two marks");
  assert.equal(text.indexOf("│"), 18, "start mark before cell 18 (75–79%)");
  assert.equal(text.lastIndexOf("│"), 22, "threshold mark before cell 21 (87.5–91.7%)");
  assert.equal([...text].filter((char) => char === "━").length, 14);
  assert.equal(
    gauge(null, undefined, undefined, "muted")
      .map(([part]) => part)
      .join(""),
    "─".repeat(24),
  );
});

test("card shows state, both marks, the expected result, request usage and keys", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const lines = renderCard(ready, f.ctx.ui.theme, 120, now).map(plain);
  assert.match(lines[0], /^╭─ Background compaction ─+╮$/);
  assert.match(lines.at(-1) ?? "", /^╰─+╯$/);
  for (const line of lines.slice(1, -1)) assert.match(line, /^│ .* │$/);
  const body = lines.join("\n");
  assert.match(body, /● ready {3}Summary held until native threshold compaction/);
  assert.match(body, /Context {3}.*60\.0% of 100k/);
  assert.match(body, /start 76\.5% · Pi compacts at 90\.0%/);
  assert.match(body, /Summary {3}60k → ~21k tokens · prepared in 48s, 2 min ago/);
  assert.match(body, /Request {3}41k in · 2\.9k out · \$0\.012/);
  assert.match(body, /Failures {2}0\/2/);
  assert.match(body, /r reset {3}o off {3}esc close/);
  for (const width of [1, 10, 30, 60, 76, 120]) {
    for (const line of renderCard(ready, f.ctx.ui.theme, width, now)) {
      assert.ok(visibleWidth(line) <= width, `overflow at ${width}: ${plain(line)}`);
    }
  }
});

test("card describes running, applied and unknown context states", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const render = (details: StatusDetails) =>
    renderCard(details, f.ctx.ui.theme, 100, now).map(plain).join("\n");
  assert.match(
    render({ ...ready, label: "running", job: { phase: "running", startedAt: now - 42_000 } }),
    /◐ running.*\n[\s\S]*Summary {3}preparing for 42s/,
  );
  const applied = render({
    ...ready,
    label: "idle",
    reason: "Prepared summary applied",
    job: undefined,
    context: { tokens: null, window: 100_000, percent: null },
    applied: {
      tokensBefore: 91_000,
      tokensAfter: 21_000,
      preparedMs: 48_000,
      waitedMs: 0,
      at: now - 180_000,
    },
  });
  assert.match(applied, /○ applied {3}Prepared summary applied/);
  assert.match(applied, /unknown until the next response/);
  assert.match(applied, /Summary {3}applied 3 min ago · 91k → ~21k tokens/);
  assert.match(render({ ...ready, label: "off", enabled: false, job: undefined }), /o on {4}esc close/);
});

test("card keys reset, toggle and close; other keys do nothing", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const calls: string[] = [];
  let details = ready;
  let renders = 0;
  let closed = 0;
  const card = statusCard(
    {
      details: () => details,
      reset: () => calls.push("reset"),
      setEnabled: (enabled) => {
        calls.push(`enabled=${enabled}`);
        details = { ...details, enabled };
      },
    },
    { requestRender: () => renders++ },
    f.ctx.ui.theme,
    {
      matches: (data, id) =>
        (id === "tui.select.cancel" && data === "\u001b") || (id === "tui.select.confirm" && data === "\r"),
    },
    () => closed++,
  );
  t.after(() => card.dispose());
  card.handleInput?.("x");
  card.handleInput?.("r");
  card.handleInput?.("o");
  card.handleInput?.("o");
  assert.deepEqual(calls, ["reset", "enabled=false", "enabled=true"]);
  assert.equal(renders, 3);
  assert.equal(closed, 0);
  card.handleInput?.("\u001b");
  card.handleInput?.("\r");
  assert.equal(closed, 2);
});
