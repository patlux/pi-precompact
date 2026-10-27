#!/usr/bin/env node
// Contact sheets for the visual review loop, adapted from claude-motion's scripts/sheet.mjs
// (https://github.com/whaleyxbt/claude-motion, MIT, see LICENSE.claude-motion).
//
//   node scripts/sheet.mjs                      start + 0.3 s, middle and end of every segment
//   node scripts/sheet.mjs 2.3 4.5 6.9          exact timestamps
//   node scripts/sheet.mjs --from 3 --to 5 --every 0.2
//
// Options: --video out/draft.mp4  --cols 4  --rows 3  --size 640  --name beats
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
};

const newest = ["out/draft.mp4", "out/precompact.mp4"]
  .map((file) => path.join(ROOT, file))
  .filter((file) => fs.existsSync(file))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const video = path.resolve(option("video", newest ?? ""));
const every = option("every", null);
const from = Number(option("from", "0"));
const to = option("to", null);
const cols = Number(option("cols", "4"));
const rows = Number(option("rows", "3"));
const size = Number(option("size", "640"));
let name = option("name", null);
if (!video || !fs.existsSync(video)) {
  console.error("No video found. Run `npm run draft` first or pass --video <file>.");
  process.exit(1);
}

const duration = Number(
  execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video])
    .toString()
    .trim(),
);

let times;
if (argv.length) {
  times = argv.map(Number);
  name ??= "picked";
} else if (every) {
  const end = to === null ? duration : Number(to);
  times = [];
  for (let t = from; t <= end + 1e-6; t += Number(every)) times.push(Number(t.toFixed(3)));
  name ??= `every${every}`;
} else {
  const plan = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "generated", "plan.json"), "utf8"));
  times = plan.segments.flatMap((s) => [s.filmStart + 0.3, (s.filmStart + s.filmEnd) / 2, s.filmEnd - 0.05]);
  name ??= "beats";
}
times = [...new Set(times.map((t) => Math.min(Math.max(t, 0), duration - 1 / 60).toFixed(2)))]
  .map(Number)
  .sort((a, b) => a - b);

const dir = path.join(ROOT, "out", "sheets", name);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const ffmpeg = (args) => execFileSync("ffmpeg", ["-loglevel", "error", "-y", ...args], { stdio: "pipe" });

times.forEach((t, i) => {
  const file = path.join(dir, `${String(i).padStart(3, "0")}.png`);
  const label = `drawtext=font=monospace:text='t=${t.toFixed(2)}':x=10:y=10:fontsize=${Math.round(size / 24)}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6`;
  ffmpeg(["-ss", String(t), "-i", video, "-frames:v", "1", "-vf", `scale=${size}:-2,${label}`, file]);
});

const perSheet = cols * rows;
const sheets = [];
for (let s = 0; s * perSheet < times.length; s++) {
  const out = path.join(ROOT, "out", "sheets", `${name}-${s + 1}.png`);
  ffmpeg([
    "-framerate",
    "1",
    "-start_number",
    String(s * perSheet),
    "-i",
    path.join(dir, "%03d.png"),
    "-vf",
    `tile=${cols}x${rows}:padding=6:color=0x333333`,
    "-frames:v",
    "1",
    out,
  ]);
  sheets.push(path.relative(ROOT, out));
}
console.log(`${times.length} frames from ${path.relative(ROOT, video)} → ${sheets.length} sheet(s):`);
for (const sheet of sheets) console.log(`  ${sheet}`);
