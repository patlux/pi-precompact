#!/usr/bin/env python3
"""Render a recording from record.py into README and gallery media with agg and ffmpeg.

Demo only. Needs agg, gifsicle, ffmpeg and ffprobe on PATH, and font directories with MesloLGS Nerd Font
Mono and DejaVu Sans Mono (--font-dir). Every image is a frame of the real recording; crops select
terminal rows, and the slow-motion clip only changes the playback speed.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from record import THEME

FONT_FAMILY = "MesloLGS Nerd Font Mono,DejaVu Sans Mono,DejaVu Sans"
LINE_HEIGHT = 1.4
# Advance width of MesloLGS in em; agg 1.7.0 draws 8.4 px columns at 14 px.
COLUMN_WIDTH = 0.6
# Footer crops keep the statistics, the bar and the plugin's suffix, not the model name on the right.
FOOTER_COLUMNS = 84


def load(cast: Path) -> tuple[dict, list[list]]:
    lines = cast.read_text(encoding="utf-8").splitlines()
    return json.loads(lines[0]), [json.loads(line) for line in lines[1:]]


def window(events: list[list], start: float, end: float) -> list[list]:
    """Events up to `start` arrive at once; later ones keep their spacing until `end`."""
    selected = [[0.0, "o", event[2]] for event in events if event[0] <= start]
    selected += [[round(event[0] - start, 6), "o", event[2]] for event in events if start < event[0] <= end]
    return selected


class Renderer:
    def __init__(self, cast: Path, out: Path, font_dirs: list[str], temp: Path) -> None:
        self.header, self.events = load(cast)
        self.marks = json.loads(cast.with_suffix(".marks.json").read_text(encoding="utf-8"))
        self.out = out
        self.font_dirs = font_dirs
        self.temp = temp
        self.rows = self.header["height"]
        self.cols = self.header["width"]
        self.count = 0

    def cast(self, events: list[list]) -> Path:
        self.count += 1
        path = self.temp / f"part-{self.count}.cast"
        with path.open("w", encoding="utf-8") as file:
            file.write(json.dumps(self.header) + "\n")
            for event in events:
                file.write(json.dumps(event, ensure_ascii=False) + "\n")
        return path

    def agg(self, cast: Path, gif: Path, *, font_size: int, speed: float = 1.0, last: float = 2.0) -> None:
        theme = ",".join([THEME["bg"], THEME["fg"], *THEME["palette"]])
        command = ["agg", "--quiet", "--font-family", FONT_FAMILY, "--font-size", str(font_size)]
        for directory in self.font_dirs:
            command += ["--font-dir", directory]
        command += ["--line-height", str(LINE_HEIGHT), "--theme", theme, "--speed", str(speed)]
        command += ["--idle-time-limit", "2", "--last-frame-duration", str(last), str(cast), str(gif)]
        subprocess.run(command, check=True)

    @staticmethod
    def size(path: Path) -> tuple[int, int]:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
             "-of", "csv=p=0", str(path)],
            check=True, capture_output=True, text=True,
        )
        width, height = probe.stdout.strip().splitlines()[0].split(",")
        return int(width), int(height)

    def crop_box(self, path: Path, font_size: int, first_row: int, last_row: int) -> tuple[int, int, int, int]:
        """x, y, width and height of whole terminal rows (1-based, inclusive), FOOTER_COLUMNS wide.

        agg draws each row font_size * LINE_HEIGHT pixels high and pads the image by about half a
        row above and below and half a column left and right (measured with agg 1.7.0 at 14 and 28 px).
        """
        width, height = self.size(path)
        row = font_size * LINE_HEIGHT
        column = font_size * COLUMN_WIDTH
        pad_y = (height - self.rows * row) / 2
        pad_x = (width - self.cols * column) / 2
        top = max(0, round(pad_y + (first_row - 1) * row))
        bottom = min(height, round(pad_y + last_row * row))
        right = min(width, round(2 * pad_x + FOOTER_COLUMNS * column))
        return 0, top, right, bottom - top

    def crop_filter(self, path: Path, font_size: int, first_row: int, last_row: int) -> str:
        x, y, width, height = self.crop_box(path, font_size, first_row, last_row)
        return f"crop={width}:{height}:{x}:{y}"

    def still(self, at: float, png: Path, *, rows: tuple[int, int] | None = None, font_size: int = 28) -> None:
        gif = self.temp / f"still-{self.count}.gif"
        self.agg(self.cast(window(self.events, at, at)), gif, font_size=font_size, last=0.1)
        filters = ["select=eq(n\\,0)"]
        if rows:
            filters.append(self.crop_filter(gif, font_size, *rows))
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-i", str(gif), "-vf", ",".join(filters), "-frames:v", "1",
             str(png)],
            check=True,
        )

    def clip(self, start: float, end: float, name: str, *, speed: float = 1.0, rows: tuple[int, int] | None = None,
             font_size: int = 14, mp4: bool = False) -> None:
        gif = self.temp / f"{name}.gif"
        self.agg(self.cast(window(self.events, start, end)), gif, font_size=font_size, speed=speed, last=2.5)
        crop = [self.crop_filter(gif, font_size, *rows)] if rows else []
        # Keep agg's own palette and frame optimisation; gifsicle only crops and recompresses.
        command = ["gifsicle", "-O3", "--no-warnings"]
        if rows:
            x, y, width, height = self.crop_box(gif, font_size, *rows)
            command += ["--crop", f"{x},{y}+{width}x{height}"]
        subprocess.run([*command, str(gif), "-o", str(self.out / f"{name}.gif")], check=True)
        if mp4:
            scale = ",".join([*crop, "scale=trunc(iw/2)*2:trunc(ih/2)*2", "format=yuv420p"])
            subprocess.run(
                ["ffmpeg", "-loglevel", "error", "-y", "-i", str(gif), "-vf", scale, "-c:v", "libx264",
                 "-preset", "slow", "-crf", "20", "-movflags", "+faststart", str(self.out / f"{name}.mp4")],
                check=True,
            )

    def stack(self, parts: list[Path], png: Path) -> None:
        inputs: list[str] = []
        for part in parts:
            inputs += ["-i", str(part)]
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", *inputs, "-filter_complex",
             f"vstack=inputs={len(parts)}", str(png)],
            check=True,
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cast", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--font-dir", action="append", default=[])
    args = parser.parse_args()
    for tool in ("agg", "gifsicle", "ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            raise SystemExit(f"{tool} is not on PATH")
    args.out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="precompact-render-") as temp:
        r = Renderer(args.cast, args.out, args.font_dir, Path(temp))
        m = r.marks
        footer = (r.rows - 1, r.rows)
        stats = (r.rows, r.rows)
        r.clip(0, m["card_closed"] + 0.5, "demo", mp4=True, font_size=28)
        # Half speed: each real 40 ms frame of the reveal shows for 80 ms.
        r.clip(m["measured"] - 0.5, m["measured"] + 0.8, "reveal", speed=0.5, rows=footer, font_size=28)
        # One still before the first measured response, then every 40 ms frame of the 240 ms reveal.
        frames = [Path(temp) / f"frame-{i}.png" for i in range(9)]
        for i, frame in enumerate(frames):
            r.still(m["measured"] - 0.03 + i * 0.04, frame, rows=stats)
        r.stack(frames, args.out / "reveal-frames.png")
        states = {
            "idle": m["answer2"] + 0.8,
            "running": m["running"] + 0.4,
            "ready": m["ready"] + 1.0,
            "applied": m["applied"] + 1.5,
            "off": m["off"],
        }
        parts = [Path(temp) / f"state-{name}.png" for name in states]
        for part, at in zip(parts, states.values()):
            r.still(at, part, rows=stats)
        r.stack(parts, args.out / "footer-states.png")
        r.still(m["card"] + 3.0, args.out / "status-card.png", font_size=28)
    for path in sorted(args.out.iterdir()):
        print(f"{path.name}\t{path.stat().st_size}")


if __name__ == "__main__":
    main()
