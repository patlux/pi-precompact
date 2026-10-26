import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, FooterComponent } from "@earendil-works/pi-coding-agent";
import { type Component, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FooterState, Label } from "./controller.ts";

type Theme = ExtensionContext["ui"]["theme"];
type Color = Parameters<Theme["fg"]>[0];
type Render = FooterComponent["render"];

export const STATUS_KEY = "background-compaction";
const WIDGET_KEY = "background-compaction-footer";
/** Marks our render wrapper. `Symbol.for` keeps the key stable across extension reloads. */
const MARK = Symbol.for("pi-background-compaction.footer-render");
const MIN_PADDING = 2;
const BAR_MIN_WIDTH = 100;
const CELLS = 24;
// Pi's context segment, for example "91.6%/272k (auto)" or "?/272k".
const CONTEXT = /(^| )(\d+(?:\.\d+)?%|\?)(\/\d+(?:\.\d+)?[kM]?)( \(auto\))?(?= |$)/;
// A slice keeps the opening colour of its text but not the closing code.
const RESET_FG = "\x1b[39m";
const STATE_COLOR: Record<Label, Color> = {
  idle: "dim",
  running: "accent",
  ready: "success",
  paused: "warning",
  off: "dim",
  unavailable: "dim",
};
const FILL_COLOR: Record<Label, Color> = { ...STATE_COLOR, idle: "muted" };

interface Mark {
  readonly original: Render;
  readonly active: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMark(value: unknown): value is Mark {
  return isRecord(value) && typeof value.original === "function" && typeof value.active === "boolean";
}

function markOf(render: unknown): Mark | undefined {
  if (typeof render !== "function") return undefined;
  const mark: unknown = Reflect.get(render, MARK);
  return isMark(mark) ? mark : undefined;
}

function isComponent(value: unknown): value is Component {
  return (
    isRecord(value) &&
    "render" in value &&
    typeof value.render === "function" &&
    "invalidate" in value &&
    typeof value.invalidate === "function"
  );
}

function isBuiltInFooter(component: Component): component is FooterComponent {
  // Host and extension modules can load separate class identities. Require Pi's
  // component name and its distinctive public API instead of instanceof.
  return (
    component.constructor.name === "FooterComponent" &&
    "setSession" in component &&
    typeof component.setSession === "function" &&
    "setAutoCompactEnabled" in component &&
    typeof component.setAutoCompactEnabled === "function"
  );
}

/** The single mounted built-in footer, or undefined for custom or ambiguous layouts. */
export function findBuiltInFooter(roots: readonly Component[]): FooterComponent | undefined {
  const pending = [...roots];
  const visited = new Set<Component>();
  const footers: FooterComponent[] = [];
  while (pending.length > 0) {
    const component = pending.pop();
    if (!component || visited.has(component)) continue;
    visited.add(component);
    if (isBuiltInFooter(component)) footers.push(component);
    else if ("children" in component) {
      const children: unknown = component.children;
      if (Array.isArray(children) && children.every(isComponent)) pending.push(...children);
    }
  }
  return footers.length === 1 ? footers[0] : undefined;
}

function readStatuses(footer: FooterComponent): ReadonlyMap<string, string> | undefined {
  // Pi has no public status-placement API. Read the instance's provider defensively;
  // anything unexpected keeps Pi's own status row.
  const provider: unknown = Reflect.get(footer, "footerData");
  if (!isRecord(provider) || typeof provider.getExtensionStatuses !== "function") return undefined;
  const statuses: unknown = provider.getExtensionStatuses();
  if (
    !(statuses instanceof Map) ||
    ![...statuses].every(([key, text]) => typeof key === "string" && typeof text === "string")
  )
    return undefined;
  return statuses;
}

/** Pi's status row, optionally without this plugin's entry. */
function statusRow(statuses: ReadonlyMap<string, string>, theme: Theme, width: number, omitOwn = false) {
  const entries = [...statuses].filter(([key]) => !omitOwn || key !== STATUS_KEY);
  if (entries.length === 0) return undefined;
  const text = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) =>
      value
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim(),
    )
    .join(" ");
  return truncateToWidth(text, width, theme.fg("dim", "..."));
}

/** Context bar with the background start (accent) and Pi's threshold (error) as marks. */
function gauge(percent: number | null, state: FooterState, theme: Theme): string {
  const filled = percent === null ? 0 : Math.round((Math.min(Math.max(percent, 0), 100) / 100) * CELLS);
  const fill = state.applied ? "muted" : FILL_COLOR[state.state];
  const marks = new Map<number, Color>();
  if (state.start !== undefined) marks.set(Math.min(CELLS - 1, Math.floor(state.start * CELLS)), "accent");
  if (state.threshold !== undefined)
    marks.set(Math.min(CELLS - 1, Math.floor(state.threshold * CELLS)), "error");
  let text = "";
  for (let cell = 0; cell < CELLS; cell++) {
    const mark = marks.get(cell);
    if (mark) text += theme.fg(mark, "│");
    text += cell < filled ? theme.fg(fill, "━") : theme.fg("dim", "─");
  }
  return text;
}

/** Put `left` in place of everything up to the context segment's end; use padding before truncating. */
function replaceUpToContext(
  stats: string,
  plain: string,
  context: RegExpExecArray,
  left: string,
  width: number,
) {
  const leftWidth = visibleWidth(left);
  if (leftWidth + MIN_PADDING > width) return undefined;
  const end = context.index + context[0].length;
  const endColumn = visibleWidth(plain.slice(0, end));
  const padding = /^ */.exec(plain.slice(end))?.[0].length ?? 0;
  const grow = leftWidth - endColumn;
  const consumed = Math.max(0, Math.min(grow, padding - MIN_PADDING));
  const fill = grow < 0 ? " ".repeat(-grow) : "";
  const room = width - leftWidth - fill.length;
  return left + fill + truncateToWidth(sliceByColumn(stats, endColumn + consumed, room), room, "");
}

/** Bar before Pi's unchanged context segment; the expected context or the state after it. */
function barStats(
  stats: string,
  plain: string,
  context: RegExpExecArray,
  state: FooterState,
  theme: Theme,
  width: number,
) {
  const [, lead = "", percentText = "", windowText = "", autoText = ""] = context;
  const column = visibleWidth(plain.slice(0, context.index + lead.length));
  const percent = percentText === "?" ? null : Number.parseFloat(percentText);
  const native = sliceByColumn(stats, column, visibleWidth(percentText + windowText + autoText)) + RESET_FG;
  const expected =
    state.state === "ready" && state.after !== undefined && percent !== null
      ? theme.fg("dim", " → ") + theme.fg("success", `~${Math.round(state.after * 100)}%`)
      : "";
  const suffix =
    state.applied && state.state === "idle"
      ? theme.fg("success", " ✓ bg")
      : state.state === "idle" || expected
        ? ""
        : theme.fg("dim", " bg ") + theme.fg(STATE_COLOR[state.state], state.state);
  const left = `${sliceByColumn(stats, 0, column)}${gauge(percent, state, theme)} ${native}${expected}${suffix}`;
  return replaceUpToContext(stats, plain, context, left, width);
}

/** Compact form: Pi's context segment unchanged, then the coloured state. */
function textStats(
  stats: string,
  plain: string,
  context: RegExpExecArray,
  state: FooterState,
  theme: Theme,
  width: number,
) {
  const end = context.index + context[0].length;
  const column = visibleWidth(plain.slice(0, end));
  const label =
    state.applied && state.state === "idle"
      ? theme.fg("success", " ✓ bg")
      : theme.fg("dim", " bg: ") + theme.fg(STATE_COLOR[state.state], state.state);
  const labelWidth = visibleWidth(label);
  if (column + labelWidth > width) return undefined;
  const padding = /^ */.exec(plain.slice(end))?.[0].length ?? 0;
  const consumed = Math.min(labelWidth, Math.max(0, padding - MIN_PADDING));
  const room = width - column - labelWidth;
  return (
    sliceByColumn(stats, 0, column) +
    label +
    truncateToWidth(sliceByColumn(stats, column + consumed, room), room, "")
  );
}

/**
 * Move this plugin's status from Pi's status row into the statistics line.
 * Only Pi's known three-line layout is changed; anything else is returned unchanged.
 */
export function inlineStatus(
  lines: string[],
  statuses: ReadonlyMap<string, string> | undefined,
  state: FooterState | undefined,
  theme: Theme,
  width: number,
): string[] {
  if (!state || !statuses || statuses.get(STATUS_KEY) !== `bg compact: ${state.state}`) return lines;
  if (lines.length !== 3 || lines[2] !== statusRow(statuses, theme, width)) return lines;
  const stats = lines[1];
  const plain = stripVTControlCharacters(stats);
  const context = CONTEXT.exec(plain);
  if (!context) return lines;
  const inline =
    (width >= BAR_MIN_WIDTH ? barStats(stats, plain, context, state, theme, width) : undefined) ??
    textStats(stats, plain, context, state, theme, width);
  if (inline === undefined) return lines;
  const rest = statusRow(statuses, theme, width, true);
  return rest === undefined ? [lines[0], inline] : [lines[0], inline, rest];
}

/**
 * Decorate the render method of this one footer instance. Other decorators may wrap it
 * before or after; each keeps the other's lines. Returns an idempotent undo.
 */
export function decorateFooter(footer: FooterComponent, theme: Theme, state: () => FooterState | undefined) {
  // Drop our own inactive wrappers from earlier runtimes when they are on top.
  for (let mark = markOf(footer.render); mark && !mark.active; mark = markOf(footer.render)) {
    footer.render = mark.original;
  }
  const original = footer.render;
  let active = true;
  const render = function (this: FooterComponent, width: number): string[] {
    const lines = original.call(this, width);
    return active ? inlineStatus(lines, readStatuses(this), state(), theme, width) : lines;
  };
  const mark: Mark = {
    original,
    get active() {
      return active;
    },
  };
  Reflect.defineProperty(render, MARK, { value: mark });
  footer.render = render;
  return () => {
    if (!active) return;
    active = false;
    // A later decorator keeps working; our wrapper then only passes through.
    if (footer.render === render) footer.render = original;
  };
}

/**
 * Pi exposes the live TUI only to widget factories. A zero-row widget below the editor
 * finds the built-in footer without adding layout space. Without it, Pi's status row remains.
 */
export function attachFooter(ctx: ExtensionContext, state: () => FooterState | undefined): () => void {
  let undo: (() => void) | undefined;
  ctx.ui.setWidget(
    WIDGET_KEY,
    (tui, theme) => {
      const footer = findBuiltInFooter(tui.children);
      undo = footer ? decorateFooter(footer, theme, state) : undefined;
      return { render: () => [], invalidate() {}, dispose: () => undo?.() };
    },
    { placement: "belowEditor" },
  );
  return () => {
    undo?.();
    undo = undefined;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  };
}
