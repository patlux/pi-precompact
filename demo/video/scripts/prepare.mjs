#!/usr/bin/env node
// Turn a demo/record.py recording into the film's inputs. The terminal bytes are replayed unchanged
// through @xterm/headless; nothing on screen is redrawn by hand.
//
//   node scripts/prepare.mjs [recording/demo.cast]
//
// Writes public/screens.json (every distinct screen and when it appeared) and
// src/generated/plan.json (the storyboard resolved against the recording's marks).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import xterm from "@xterm/headless";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const castPath = path.resolve(process.argv[2] ?? path.join(ROOT, "recording", "demo.cast"));
const marks = JSON.parse(fs.readFileSync(castPath.replace(/\.cast$/, ".marks.json"), "utf8"));
const board = JSON.parse(fs.readFileSync(path.join(ROOT, "storyboard.json"), "utf8"));
const [headerLine, ...eventLines] = fs.readFileSync(castPath, "utf8").trim().split("\n");
const header = JSON.parse(headerLine);
const events = eventLines.map((line) => JSON.parse(line));
const { cols, rows } = { cols: header.width, rows: header.height };

// --- Replay ---------------------------------------------------------------------------------

function xtermColour(index) {
  if (index < 16) return board.theme.palette[index];
  if (index < 232) {
    const steps = [0, 95, 135, 175, 215, 255];
    const i = index - 16;
    return `#${[Math.floor(i / 36), Math.floor(i / 6) % 6, i % 6].map((c) => steps[c].toString(16).padStart(2, "0")).join("")}`;
  }
  const level = (8 + (index - 232) * 10).toString(16).padStart(2, "0");
  return `#${level}${level}${level}`;
}

function colour(cell, layer) {
  const rgb = layer === "fg" ? cell.isFgRGB() : cell.isBgRGB();
  const palette = layer === "fg" ? cell.isFgPalette() : cell.isBgPalette();
  const value = layer === "fg" ? cell.getFgColor() : cell.getBgColor();
  if (rgb) return `#${value.toString(16).padStart(6, "0")}`;
  if (palette) return xtermColour(value);
  return null;
}

/** One screen as rows of runs: [column, cells, text, fg, bg, flags]; flags 1 bold, 2 italic, 4 underline, 8 dim. */
function snapshot(terminal) {
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();
  const screen = [];
  for (let y = 0; y < rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    const runs = [];
    for (let x = 0; x < cols; x++) {
      const current = line?.getCell(x, cell);
      if (current && current.getWidth() === 0) continue;
      let fg = current ? colour(current, "fg") : null;
      let bg = current ? colour(current, "bg") : null;
      if (current?.isInverse()) [fg, bg] = [bg ?? board.theme.bg, fg ?? board.theme.fg];
      const flags = current
        ? (current.isBold() ? 1 : 0) |
          (current.isItalic() ? 2 : 0) |
          (current.isUnderline() ? 4 : 0) |
          (current.isDim() ? 8 : 0)
        : 0;
      const chars = current && !current.isInvisible() ? current.getChars() || " " : " ";
      const width = current?.getWidth() || 1;
      const last = runs.at(-1);
      if (last && last[3] === fg && last[4] === bg && last[5] === flags && last[0] + last[1] === x) {
        last[1] += width;
        last[2] += chars;
      } else {
        runs.push([x, width, chars, fg, bg, flags]);
      }
    }
    // Trailing default-coloured blanks carry nothing.
    while (runs.length && runs.at(-1)[3] === null && runs.at(-1)[4] === null && !runs.at(-1)[2].trim())
      runs.pop();
    screen.push(runs);
  }
  return screen;
}

const terminal = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
const write = (data) => new Promise((resolve) => terminal.write(data, resolve));
const screens = [];
const keys = new Map();
const times = [];
const index = [];
let synchronized = false;
for (const [time, kind, data] of events) {
  if (kind !== "o") continue;
  await write(data);
  // Pi wraps each frame in synchronized output; a screen inside such a block is half drawn.
  const begin = data.lastIndexOf("\x1b[?2026h");
  const end = data.lastIndexOf("\x1b[?2026l");
  if (begin !== -1 || end !== -1) synchronized = begin > end;
  if (synchronized) continue;
  const screen = snapshot(terminal);
  const key = JSON.stringify(screen);
  let id = keys.get(key);
  if (id === undefined) {
    id = screens.length;
    screens.push(screen);
    keys.set(key, id);
  }
  if (index.at(-1) !== id) {
    times.push(Number(time.toFixed(4)));
    index.push(id);
  }
}

// --- Locate things on a screen ----------------------------------------------------------------

function screenAt(time) {
  let i = 0;
  while (i + 1 < times.length && times[i + 1] <= time) i++;
  return screens[index[i]];
}

function rowText(screen, y) {
  const chars = Array.from({ length: cols }, () => " ");
  for (const [x, , text] of screen[y]) {
    Array.from(text).forEach((char, i) => {
      if (x + i < cols) chars[x + i] = char;
    });
  }
  return chars.join("");
}

function find(screen, text) {
  for (let y = rows - 1; y >= 0; y--) {
    const x = rowText(screen, y).indexOf(text);
    if (x !== -1) return { row: y, col: x };
  }
  throw new Error(`"${text}" is not on screen`);
}

function fgAt(screen, y, x) {
  const run = screen[y].find(([start, width]) => x >= start && x < start + width);
  return run?.[3] ?? board.theme.fg;
}

function time(expression) {
  const match = /^([a-z0-9_]+)([+-]\d+(?:\.\d+)?)?$/.exec(expression);
  if (!match || marks[match[1]] === undefined) throw new Error(`unknown mark in "${expression}"`);
  return marks[match[1]] + Number(match[2] ?? 0);
}

const stats = rows - 1;
function bar(screen) {
  const text = rowText(screen, stats);
  const cells = [...text].map((char, x) => ("━─│".includes(char) ? x : -1)).filter((x) => x >= 0);
  if (!cells.length) throw new Error("no context bar in the statistics line");
  return { col0: cells[0], col1: cells.at(-1) };
}

function shot(spec, at) {
  if (spec === "wide") return { col0: 0, col1: cols - 1, row0: 0, row1: rows - 1, window: true };
  const screen = screenAt(at);
  if (spec === "footer") return { col0: 0, col1: 84, row0: rows - 3, row1: rows - 1 };
  if (spec === "bar") {
    // The whole statistics line up to Pi's context value, with the path line above it.
    const { col1 } = bar(screenAt(time("measured+1")));
    return { col0: 0, col1: col1 + 19, row0: rows - 2, row1: rows - 1 };
  }
  const [col0, col1] = spec.cols ?? [0, cols - 1];
  if (spec.rows) {
    // Negative rows count from the bottom: -1 is the statistics line.
    const [row0, row1] = spec.rows.map((row) => (row < 0 ? rows + row : row));
    return { col0, col1, row0, row1 };
  }
  const { row } = find(screen, spec.find);
  return { col0, col1, row0: Math.max(0, row - spec.above), row1: Math.min(rows - 1, row + spec.below) };
}

// --- Numbers shown on screen, read back rather than typed in ----------------------------------

const card = rowText(screenAt(time("card+2")), find(screenAt(time("card+2")), "Pi compacts at").row);
const [, start, threshold] = /start ([\d.]+%) · Pi compacts at ([\d.]+%)/.exec(card) ?? [];
const readyText = rowText(screenAt(time("ready+1")), stats);
const expected = /→ (~[\d.]+%)/.exec(readyText)?.[1];
if (!start || !threshold || !expected) throw new Error("could not read the thresholds from the recording");
const numbers = { start: start.replace(".0%", "%"), threshold: threshold.replace(".0%", "%"), expected };

function overlay(kind, at) {
  const screen = screenAt(at);
  if (kind === "marks") {
    const text = rowText(screen, stats);
    const ticks = [...text].map((char, x) => (char === "│" ? x : -1)).filter((x) => x >= 0);
    return {
      kind,
      row: stats,
      marks: [
        { col: ticks[0], colour: fgAt(screen, stats, ticks[0]), text: `plugin starts · ${numbers.start}` },
        { col: ticks[1], colour: fgAt(screen, stats, ticks[1]), text: `Pi compacts · ${numbers.threshold}` },
      ],
    };
  }
  const label = { running: "pre running", ready: "→ ~", notice: "✓ Background summary applied" }[kind];
  const { row, col } = find(screen, label);
  const line = rowText(screen, row);
  const end = kind === "ready" ? line.indexOf("%", col) : line.trimEnd().length - 1;
  return { kind, row, col0: col, col1: end, colour: fgAt(screen, row, kind === "notice" ? col + 2 : col) };
}

// --- Resolve the storyboard into film segments ------------------------------------------------

const segments = [];
let film = 0;
for (const clip of board.clips) {
  const hold = clip.hold !== undefined;
  const sourceStart = hold ? time(clip.at) : time(clip.from);
  const sourceEnd = hold ? sourceStart : time(clip.to);
  const duration = hold ? clip.hold : (sourceEnd - sourceStart) / clip.speed;
  if (!(duration > 0)) throw new Error(`clip ${clip.id} has no duration`);
  const focusAt = typeof clip.shot === "object" && clip.shot.at ? time(clip.shot.at) : sourceEnd;
  const fill = (text) => text.replace(/\{(\w+)\}/g, (_, name) => numbers[name]);
  segments.push({
    id: clip.id,
    filmStart: Number(film.toFixed(4)),
    filmEnd: Number((film + duration).toFixed(4)),
    sourceStart,
    sourceEnd,
    speed: hold ? 0 : clip.speed,
    shot: shot(clip.shot, focusAt),
    overlay: clip.overlay ? overlay(clip.overlay, sourceEnd) : null,
    caption: clip.caption ? { ...clip.caption, text: fill(clip.caption.text) } : null,
    outro: Boolean(clip.outro),
  });
  film += duration;
}

const out = path.join(ROOT, "src", "generated");
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(path.join(ROOT, "public"), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, "public", "screens.json"),
  JSON.stringify({ cols, rows, times, index, screens }),
);
const plan = { duration: Number(film.toFixed(3)), numbers, segments };
fs.writeFileSync(path.join(out, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
console.log(
  `${screens.length} screens, ${times.length} changes; film ${plan.duration}s; ` +
    `start ${numbers.start}, threshold ${numbers.threshold}, expected ${numbers.expected}`,
);
