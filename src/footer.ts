import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, FooterComponent, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  type Color,
  type Component,
  foregroundAnsi,
  getTerminalColorMode,
  mixColors,
  rgbColor,
  sliceByColumn,
  type TerminalColors,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { FooterStyle } from "./config.ts";
import type { FooterState, Label } from "./controller.ts";
import { formatDuration, formatTokens } from "./format.ts";

type Theme = ExtensionContext["ui"]["theme"];
type Token = Parameters<Theme["fg"]>[0];
type Render = FooterComponent["render"];
type Segment = readonly [text: string, token: Token];

export const STATUS_KEY = "precompact";
const WIDGET_KEY = "precompact-footer";
/** Marks our render wrapper. `Symbol.for` keeps the key stable across extension reloads. */
const MARK = Symbol.for("pi-precompact.footer-render");
const MIN_PADDING = 2;
/** The narrowest terminal that shows each style; narrower ones fall back to the compact text form. */
const MIN_WIDTH: Record<FooterStyle, number> = { bar: 100, short: 80, block: 0, text: 0, underline: 0 };
const CELLS: Partial<Record<FooterStyle, number>> = { bar: 24, short: 8 };
const BLOCKS = "▁▂▃▄▅▆▇█";
// Pi's context segment, for example "91.6%/272k (auto)" or "?/272k".
const CONTEXT = /(^| )(\d+(?:\.\d+)?%|\?)(\/\d+(?:\.\d+)?[kM]?)( \(auto\))?(?= |$)/;
// A slice keeps the opening colour of its text but not the closing code.
const RESET_FG = "\x1b[39m";
const UNDERLINE_ON = "\x1b[4m";
// 24 ends the underline, 59 restores the default underline colour.
const UNDERLINE_OFF = "\x1b[24m\x1b[59m";
const STATE_COLOR: Record<Label, Token> = {
  idle: "dim",
  running: "accent",
  ready: "success",
  paused: "warning",
  off: "dim",
  unavailable: "dim",
};
const FILL_COLOR: Record<Label, Token> = { ...STATE_COLOR, idle: "muted" };

// Fade-in (design: design/figcraft, page 04). A frame every 40 ms; each glyph fades in over
// 120 ms, 5 ms later than its left neighbour; the fill grows from 80 to 240 ms.
const FRAME_MS = 40;
const WAVE_MS = 5;
const FADE_MS = 120;
const FILL_START_MS = 80;
const FILL_MS = 160;
/** Long enough for 26 bar glyphs and the suffix after them. */
export const REVEAL_MS = 26 * WAVE_MS + FADE_MS;

function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (t: number, a: number, b: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let low = 0;
    let high = 1;
    for (let i = 0; i < 30; i++) {
      const mid = (low + high) / 2;
      if (at(mid, x1, x2) < x) low = mid;
      else high = mid;
    }
    return at((low + high) / 2, y1, y2);
  };
}
const easeOut = cubicBezier(0.23, 1, 0.32, 1);
const progress = (elapsed: number, start: number, length: number) =>
  easeOut(Math.min(1, Math.max(0, (elapsed - start) / length)));

/** Whether Pi has measured a response yet; before that Pi shows no usage numbers either. */
export function hasMeasuredUsage(entries: readonly SessionEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.usage.input +
        entry.message.usage.output +
        entry.message.usage.cacheRead +
        entry.message.usage.cacheWrite >
        0,
  );
}

/** What the renderer needs from the reveal: the animation phase and the terminal background. */
export interface RevealView {
  /** Undefined: hidden. A number: milliseconds since the bar appeared. Infinity: settled. */
  phase(key: string): number | undefined;
  readonly background?: Color;
}

const SETTLED: RevealView = { phase: () => Infinity };

/**
 * Keeps the bar hidden until the session has a measured response, then fades it in once.
 * A session that already has one, for example after /resume or /reload, shows it at once.
 */
export class Reveal implements RevealView {
  background?: Color;
  private measured: boolean;
  private leaf: string | null;
  private startedAt?: number;
  private key?: string;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly session: Pick<ExtensionContext["sessionManager"], "getLeafId" | "getEntries">,
    private readonly motion: boolean,
    private readonly requestRender: () => void,
    private readonly now: () => number = Date.now,
  ) {
    this.leaf = session.getLeafId();
    this.measured = hasMeasuredUsage(session.getEntries());
  }

  /** Whether a later first response will animate. */
  get pending(): boolean {
    return !this.measured && this.motion;
  }

  phase(key: string): number | undefined {
    if (!this.measured) {
      // Every appended entry moves the leaf; only then can a measured response have arrived.
      const leaf = this.session.getLeafId();
      if (leaf === this.leaf) return undefined;
      this.leaf = leaf;
      if (!hasMeasuredUsage(this.session.getEntries())) return undefined;
      this.measured = true;
      if (!this.motion) return Infinity;
      this.startedAt = this.now();
      this.key = key;
      this.timer = setInterval(() => this.requestRender(), FRAME_MS);
      this.timer.unref?.();
    }
    if (this.startedAt === undefined) return Infinity;
    const elapsed = this.now() - this.startedAt;
    // A new width or state ends the animation: data first, motion second. A new context value does not:
    // Pi's number updates at once, and the fill grows towards it. A tool result usually follows the
    // first measured response within milliseconds and would otherwise cut the fade-in short.
    if (key !== this.key || elapsed >= REVEAL_MS) {
      this.settle();
      return Infinity;
    }
    return elapsed;
  }

  settle(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.startedAt = undefined;
  }
}

/** Paint text that fades in from the terminal background as glyph `index` of the wave. */
function painter(theme: Theme, elapsed: number, background: Color | undefined) {
  return (text: string, token: Token, index: number) => {
    if (elapsed === Infinity) return theme.fg(token, text);
    const amount = progress(elapsed, index * WAVE_MS, FADE_MS);
    if (amount <= 0) return " ".repeat(visibleWidth(text));
    if (amount >= 1 || !background) return theme.fg(token, text);
    return theme.style(text, { fg: mixColors(background, theme.colors[token], amount, "srgb") });
  };
}

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

/** Context bar of `cells` cells with the background start (accent) and Pi's threshold (error) as marks. */
function gauge(percent: number | null, state: FooterState, elapsed: number, cells: number): Segment[] {
  const measured = percent === null ? 0 : Math.round((Math.min(Math.max(percent, 0), 100) / 100) * cells);
  const filled =
    elapsed === Infinity ? measured : Math.round(measured * progress(elapsed, FILL_START_MS, FILL_MS));
  const fill = state.applied ? "muted" : FILL_COLOR[state.state];
  const marks = new Map<number, Token>();
  if (state.start !== undefined) marks.set(Math.min(cells - 1, Math.floor(state.start * cells)), "accent");
  if (state.threshold !== undefined)
    marks.set(Math.min(cells - 1, Math.floor(state.threshold * cells)), "error");
  const glyphs: Segment[] = [];
  for (let cell = 0; cell < cells; cell++) {
    const mark = marks.get(cell);
    if (mark) glyphs.push(["│", mark]);
    glyphs.push(cell < filled ? ["━", fill] : ["─", "dim"]);
  }
  return glyphs;
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

/** Expected context after adoption, or the state, after Pi's segment. */
function suffixOf(state: FooterState, percent: number | null): Segment[] {
  if (state.state === "ready" && state.after !== undefined && percent !== null)
    return [
      [" → ", "dim"],
      [`~${Math.round(state.after * 100)}%`, "success"],
    ];
  if (state.applied && state.state === "idle") return [[" ✓ pre", "success"]];
  if (state.state === "idle") return [];
  return [
    [" pre ", "dim"],
    [state.state, STATE_COLOR[state.state]],
  ];
}

/** One block glyph, full at Pi's threshold rather than at the end of the window; the state colours it. */
function block(percent: number | null, state: FooterState, elapsed: number): Segment {
  if (percent === null) return [BLOCKS[0] ?? "", "dim"];
  const level = Math.min(1, Math.max(0, percent / 100 / (state.threshold ?? 1)));
  const grown = elapsed === Infinity ? level : level * progress(elapsed, FILL_START_MS, FILL_MS);
  // Round down: the full block appears only at the threshold itself.
  const glyph = BLOCKS[grown >= 1 ? BLOCKS.length - 1 : Math.floor(grown * (BLOCKS.length - 1))] ?? "";
  return [glyph, state.applied ? "muted" : FILL_COLOR[state.state]];
}

/** Whole seconds since the background request started; the render for the next second is scheduled. */
function runningSeconds(state: FooterState, now: number): number | undefined {
  return state.runningSince === undefined
    ? undefined
    : Math.max(0, Math.floor((now - state.runningSince) / 1000));
}

/**
 * The text style's suffix: the tokens left until the plugin starts while idle, the running time while
 * running, otherwise the same suffix as the bar.
 */
function textSuffixOf(state: FooterState, percent: number | null, now: number): Segment[] {
  if (state.state === "idle" && !state.applied) {
    if (percent === null || state.start === undefined || state.window === undefined) return [];
    // Pi's percentage has one decimal; the estimate is good to about a thousandth of the window.
    const left = (state.start - percent / 100) * state.window;
    return left >= 1000 ? [[` pre in ${formatTokens(left)}`, "dim"]] : [];
  }
  const seconds = runningSeconds(state, now);
  if (state.state === "running" && seconds !== undefined)
    return [
      [" pre ", "dim"],
      [`running ${formatDuration(seconds * 1000)}`, STATE_COLOR.running],
    ];
  return suffixOf(state, percent);
}

/** The glyphs this style draws before Pi's segment. */
function leadOf(style: FooterStyle, percent: number | null, state: FooterState, elapsed: number): Segment[] {
  const cells = CELLS[style];
  if (cells !== undefined) return gauge(percent, state, elapsed, cells);
  if (style === "block") return [block(percent, state, elapsed)];
  return [];
}

/** Glyphs before Pi's unchanged context segment; the expected context or the state after it. */
function leadStats(
  stats: string,
  plain: string,
  context: RegExpExecArray,
  state: FooterState,
  theme: Theme,
  width: number,
  elapsed: number,
  background: Color | undefined,
  style: FooterStyle,
  now: number,
) {
  const [, lead = "", percentText = "", windowText = "", autoText = ""] = context;
  const column = visibleWidth(plain.slice(0, context.index + lead.length));
  const percent = percentText === "?" ? null : Number.parseFloat(percentText);
  // Pi's own segment and colours appear at once; only the glyphs and the suffix fade in.
  const native = sliceByColumn(stats, column, visibleWidth(percentText + windowText + autoText)) + RESET_FG;
  const paint = painter(theme, elapsed, background);
  const glyphs = leadOf(style, percent, state, elapsed);
  const bar = glyphs.map(([text, token], index) => paint(text, token, index)).join("");
  const suffix = (style === "text" ? textSuffixOf(state, percent, now) : suffixOf(state, percent))
    .map(([text, token]) => paint(text, token, glyphs.length))
    .join("");
  const left = `${sliceByColumn(stats, 0, column)}${bar}${glyphs.length > 0 ? " " : ""}${native}${suffix}`;
  return replaceUpToContext(stats, plain, context, left, width);
}

/**
 * SGR 58 in its colon form, as kitty, Ghostty, WezTerm and iTerm2 read it. Pi's ANSI tracker ignores
 * colon parameters; the semicolon form would make it read the 2 in `58;2;…` as dim when it re-opens
 * styles after a wrap. Terminals without underline colours draw the underline in the text colour.
 */
function underlineColor(color: Color): string {
  // "\x1b[38;5;Nm" or "\x1b[38;2;R;G;Bm" in the terminal's colour mode.
  const [, kind, ...values] = foregroundAnsi(color, getTerminalColorMode()).slice(2, -1).split(";");
  if (kind === "5" && values.length === 1) return `\x1b[58:5:${values[0]}m`;
  if (kind === "2" && values.length === 3) return `\x1b[58:2::${values.join(":")}m`;
  return "";
}

/** Pi's context segment underlined as far as the context is filled; the suffix as with the bar. */
function underlineStats(
  stats: string,
  plain: string,
  context: RegExpExecArray,
  state: FooterState,
  theme: Theme,
  width: number,
  elapsed: number,
  background: Color | undefined,
) {
  const [, lead = "", percentText = "", windowText = "", autoText = ""] = context;
  const column = visibleWidth(plain.slice(0, context.index + lead.length));
  const percent = percentText === "?" ? null : Number.parseFloat(percentText);
  const segment = visibleWidth(percentText + windowText + autoText);
  const measured = percent === null ? 0 : Math.round((Math.min(Math.max(percent, 0), 100) / 100) * segment);
  // The fade-in grows the underline like the bar's fill.
  const length =
    elapsed === Infinity ? measured : Math.round(measured * progress(elapsed, FILL_START_MS, FILL_MS));
  const token = state.applied ? "muted" : FILL_COLOR[state.state];
  const underlined =
    length > 0
      ? `${UNDERLINE_ON}${underlineColor(theme.colors[token])}${sliceByColumn(stats, column, length)}${UNDERLINE_OFF}`
      : "";
  const rest = length < segment ? sliceByColumn(stats, column + length, segment - length) : "";
  const paint = painter(theme, elapsed, background);
  const suffix = suffixOf(state, percent)
    .map(([text, color]) => paint(text, color, segment))
    .join("");
  const left = `${sliceByColumn(stats, 0, column)}${underlined}${rest}${RESET_FG}${suffix}`;
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
      ? theme.fg("success", " ✓ pre")
      : theme.fg("dim", " pre: ") + theme.fg(STATE_COLOR[state.state], state.state);
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

export interface InlineOptions {
  readonly reveal?: RevealView;
  readonly style?: FooterStyle;
  /** The clock for the text style's running time. */
  readonly now?: number;
}

/**
 * Move this plugin's status from Pi's status row into the statistics line.
 * Before the first measured response, show nothing at all, like Pi.
 * Only Pi's known three-line layout is changed; anything else is returned unchanged.
 */
export function inlineStatus(
  lines: string[],
  statuses: ReadonlyMap<string, string> | undefined,
  state: FooterState | undefined,
  theme: Theme,
  width: number,
  { reveal = SETTLED, style = "bar", now = Date.now() }: InlineOptions = {},
): string[] {
  if (!state || !statuses || statuses.get(STATUS_KEY) !== `precompact: ${state.state}`) return lines;
  if (lines.length !== 3 || lines[2] !== statusRow(statuses, theme, width)) return lines;
  const stats = lines[1];
  const plain = stripVTControlCharacters(stats);
  const context = CONTEXT.exec(plain);
  if (!context) return lines;
  // Before the first measured response Pi shows no usage; show nothing either.
  const elapsed = reveal.phase(`${width}|${state.state}|${state.applied}`);
  const decorated =
    elapsed === undefined || width < MIN_WIDTH[style]
      ? undefined
      : style === "underline"
        ? underlineStats(stats, plain, context, state, theme, width, elapsed, reveal.background)
        : leadStats(stats, plain, context, state, theme, width, elapsed, reveal.background, style, now);
  const inline =
    elapsed === undefined ? stats : (decorated ?? textStats(stats, plain, context, state, theme, width));
  if (inline === undefined) return lines;
  const rest = statusRow(statuses, theme, width, true);
  return rest === undefined ? [lines[0], inline] : [lines[0], inline, rest];
}

/**
 * Decorate the render method of this one footer instance. Other decorators may wrap it
 * before or after; each keeps the other's lines. Returns an idempotent undo.
 */
export function decorateFooter(
  footer: FooterComponent,
  theme: Theme,
  state: () => FooterState | undefined,
  options: { reveal?: RevealView; style?: FooterStyle; tick?: (delayMs: number) => void } = {},
) {
  // Drop our own inactive wrappers from earlier runtimes when they are on top.
  for (let mark = markOf(footer.render); mark && !mark.active; mark = markOf(footer.render)) {
    footer.render = mark.original;
  }
  const original = footer.render;
  let active = true;
  const render = function (this: FooterComponent, width: number): string[] {
    const lines = original.call(this, width);
    if (!active) return lines;
    const current = state();
    const now = Date.now();
    // The text style counts the running time in seconds: ask for the render of the next second.
    if (options.style === "text" && current?.state === "running" && current.runningSince !== undefined)
      options.tick?.(1000 - ((now - current.runningSince) % 1000));
    return inlineStatus(lines, readStatuses(this), current, theme, width, { ...options, now });
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
export function attachFooter(
  ctx: ExtensionContext,
  state: () => FooterState | undefined,
  options: { motion: boolean; style?: FooterStyle },
): () => void {
  let undo: (() => void) | undefined;
  let reveal: Reveal | undefined;
  let tick: ReturnType<typeof setTimeout> | undefined;
  const stopTick = () => {
    if (tick) clearTimeout(tick);
    tick = undefined;
  };
  ctx.ui.setWidget(
    WIDGET_KEY,
    (tui, theme) => {
      const footer = findBuiltInFooter(tui.children);
      const current = new Reveal(ctx.sessionManager, options.motion, () => tui.requestRender());
      reveal = current;
      // At most one pending timer; it ends by itself when the state stops running.
      const schedule = (delayMs: number) => {
        if (tick) return;
        tick = setTimeout(() => {
          tick = undefined;
          tui.requestRender();
        }, delayMs);
        tick.unref?.();
      };
      undo = footer
        ? decorateFooter(footer, theme, state, { reveal: current, style: options.style, tick: schedule })
        : undefined;
      // The fade needs the real terminal background. Without an answer or truecolor,
      // each glyph appears in its final colour when the wave reaches it.
      if (footer && current.pending && getTerminalColorMode() === "truecolor") {
        // Startup can outlast the timeout; like Pi's theme, accept a late reply too.
        const apply = ({ background }: TerminalColors) => {
          if (background) current.background = rgbColor(background.r, background.g, background.b);
        };
        tui.queryTerminalColors({ timeoutMs: 150, onLateReply: apply }).then(apply, () => {});
      }
      return {
        render: () => [],
        invalidate() {},
        dispose: () => {
          current.settle();
          stopTick();
          undo?.();
        },
      };
    },
    { placement: "belowEditor" },
  );
  return () => {
    reveal?.settle();
    stopTick();
    undo?.();
    undo = undefined;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  };
}
