import type { ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Label, StatusDetails } from "./controller.ts";
import { formatDuration, formatShare, formatTokens } from "./format.ts";

type Theme = ExtensionContext["ui"]["theme"];
type Color = Parameters<Theme["fg"]>[0];
type Segment = readonly [text: string, color?: Color];

const MAX_WIDTH = 76;
const CELLS = 24;
const LABEL = 10;
const GLYPH: Record<Label, Segment> = {
  idle: ["○", "muted"],
  running: ["◐", "accent"],
  ready: ["●", "success"],
  paused: ["‖", "warning"],
  off: ["–", "dim"],
  unavailable: ["×", "dim"],
};

/** What the card can change. The controller implements it. */
export interface CardActions {
  details(): StatusDetails;
  reset(): void;
  setEnabled(enabled: boolean): void;
}

/** Context bar with the background start and Pi's threshold as marks. */
export function gauge(
  percent: number | null,
  start: number | undefined,
  threshold: number | undefined,
  fill: Color,
) {
  const filled = percent === null ? 0 : Math.round((Math.min(Math.max(percent, 0), 100) / 100) * CELLS);
  const marks = new Map<number, Color>();
  if (start !== undefined) marks.set(Math.min(CELLS - 1, Math.floor(start * CELLS)), "accent");
  if (threshold !== undefined) marks.set(Math.min(CELLS - 1, Math.floor(threshold * CELLS)), "error");
  const segments: Segment[] = [];
  for (let cell = 0; cell < CELLS; cell++) {
    const mark = marks.get(cell);
    if (mark) segments.push(["│", mark]);
    segments.push(cell < filled ? ["━", fill] : ["─", "dim"]);
  }
  return segments;
}

function contextColor(percent: number | null): Color {
  if (percent === null) return "dim";
  return percent > 90 ? "error" : percent > 70 ? "warning" : "text";
}

function ago(at: number, now: number): string {
  const ms = now - at;
  return ms < 60_000 ? "just now" : `${Math.floor(ms / 60_000)} min ago`;
}

function rows(details: StatusDetails, now: number): Segment[][] {
  const [glyph, color] = GLYPH[details.label];
  const label = details.applied && details.label === "idle" ? "applied" : details.label;
  const out: Segment[][] = [
    [
      [glyph, color],
      [` ${label}`, color],
      [`   ${details.reason}`, "text"],
    ],
    [],
  ];
  const context = details.context;
  if (context) {
    const percent = context.percent;
    out.push([
      ["Context".padEnd(LABEL), "dim"],
      ...gauge(percent, details.start, details.threshold, color ?? "muted"),
      [
        percent === null
          ? "  unknown until the next response"
          : `  ${percent.toFixed(1)}% of ${formatTokens(context.window)}`,
        contextColor(percent),
      ],
    ]);
  }
  const marks = [
    details.start === undefined ? undefined : `start ${formatShare(details.start)}`,
    details.threshold === undefined ? undefined : `Pi compacts at ${formatShare(details.threshold)}`,
  ].filter((text) => text !== undefined);
  if (marks.length) out.push([[" ".repeat(LABEL)], [marks.join(" · "), "dim"]]);
  const job = details.job;
  const tokens = context?.tokens;
  if (job?.phase === "running") {
    out.push([
      ["Summary".padEnd(LABEL), "dim"],
      [`preparing for ${formatDuration(now - job.startedAt)}`, "text"],
    ]);
  } else if (job?.phase === "ready") {
    const prepared = ` · prepared in ${formatDuration((job.readyAt ?? now) - job.startedAt)}, ${ago(job.readyAt ?? now, now)}`;
    out.push([
      ["Summary".padEnd(LABEL), "dim"],
      job.estimate === undefined || tokens == null
        ? ["estimate unavailable", "text"]
        : [`${formatTokens(tokens)} → ~${formatTokens(job.estimate)} tokens`, "text"],
      [prepared, "dim"],
    ]);
  } else if (details.applied) {
    const applied = details.applied;
    out.push([
      ["Summary".padEnd(LABEL), "dim"],
      [`applied ${ago(applied.at, now)}`, "text"],
      [` · ${formatTokens(applied.tokensBefore)} → ~${formatTokens(applied.tokensAfter)} tokens`, "dim"],
    ]);
  } else {
    out.push([
      ["Summary".padEnd(LABEL), "dim"],
      ["none", "dim"],
    ]);
  }
  const usage = job?.usage ?? details.applied?.usage;
  if (usage) {
    const cost = usage.cost.total > 0 ? ` · $${usage.cost.total.toFixed(3)}` : "";
    out.push([
      ["Request".padEnd(LABEL), "dim"],
      [
        `${formatTokens(usage.input + usage.cacheRead + usage.cacheWrite)} in · ${formatTokens(usage.output)} out${cost}`,
        "text",
      ],
    ]);
  }
  out.push(
    [
      ["Failures".padEnd(LABEL), "dim"],
      [`${details.failures}/2`, "text"],
    ],
    [],
  );
  out.push([
    ["r", "accent"],
    [" reset   ", "dim"],
    ["o", "accent"],
    [details.enabled ? " off   " : " on    ", "dim"],
    ["esc", "accent"],
    [" close", "dim"],
  ]);
  return out;
}

function paint(theme: Theme, segments: Segment[]): string {
  return segments.map(([text, color]) => (color ? theme.fg(color, text) : text)).join("");
}

/** Render the card. Exported for tests; `now` keeps them deterministic. */
export function renderCard(details: StatusDetails, theme: Theme, width: number, now = Date.now()): string[] {
  const outer = Math.min(MAX_WIDTH, width);
  const inner = outer - 4;
  if (inner < 8) return rows(details, now).map((row) => truncateToWidth(paint(theme, row), width, ""));
  const title = "─ Precompact ";
  const border = (text: string) => theme.fg("border", text);
  const top = border(
    `╭${truncateToWidth(title, outer - 2, "")}${"─".repeat(Math.max(0, outer - 2 - title.length))}╮`,
  );
  const body = rows(details, now).map((row) => {
    const content = truncateToWidth(paint(theme, row), inner, theme.fg("dim", "…"));
    return `${border("│ ")}${content}${" ".repeat(Math.max(0, inner - visibleWidth(content)))}${border(" │")}`;
  });
  return [top, ...body, border(`╰${"─".repeat(outer - 2)}╯`)];
}

/** The status card for an explicit `/precompact status`. Resolves when closed. */
export function statusCard(
  actions: CardActions,
  tui: Pick<TUI, "requestRender">,
  theme: Theme,
  keybindings: Pick<KeybindingsManager, "matches">,
  done: () => void,
): Component & { dispose(): void } {
  // Elapsed times and state changes appear without input. Stop with the card.
  const timer = setInterval(() => tui.requestRender(), 1000);
  timer.unref();
  return {
    render: (width) => renderCard(actions.details(), theme, width),
    invalidate() {},
    handleInput(data) {
      if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "tui.select.confirm")) {
        done();
        return;
      }
      if (data === "r") actions.reset();
      else if (data === "o") actions.setEnabled(!actions.details().enabled);
      else return;
      tui.requestRender();
    },
    dispose: () => clearInterval(timer),
  };
}
