#!/usr/bin/env python3
"""Record pi-precompact in a real Pi 1.4.0 terminal session as an asciicast v2 file.

Demo only. Pi runs in a private pseudo-terminal with a temporary HOME, the scripted model from
scripted-model.ts and a copy of this repository as the project. The driver answers Pi's colour and
device-attribute queries like a terminal with THEME, so the context bar fades in from that
background. It writes <out>.cast and <out>.marks.json (seconds of the main events).
"""

from __future__ import annotations

import argparse
import codecs
import fcntl
import json
import os
import random
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCENARIO = json.loads((ROOT / "demo" / "scenario.json").read_text(encoding="utf-8"))

# Ghostty "Sonokai"-like colours; render.py passes the same values to agg.
THEME = {
    "bg": "2c2e33",
    "fg": "e2e2e3",
    "palette": [
        "181819", "fc5d7c", "9ed072", "e7c664", "76cce0", "b39df3", "f39660", "e2e2e3",
        "7f8490", "fc5d7c", "9ed072", "e7c664", "76cce0", "b39df3", "f39660", "ffffff",
    ],
}

QUERY = re.compile(rb"\x1b\](10|11);\?(?:\x07|\x1b\\)|\x1b\]4;(\d+);\?(?:\x07|\x1b\\)|\x1b\[0?c")
ANSI = re.compile(r"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")


def osc_rgb(hex_colour: str) -> str:
    return "rgb:" + "/".join(hex_colour[i : i + 2] * 2 for i in (0, 2, 4))


def xterm_colour(index: int) -> str:
    if index < 16:
        return THEME["palette"][index]
    if index < 232:
        index -= 16
        steps = [0, 95, 135, 175, 215, 255]
        return "".join(f"{steps[c]:02x}" for c in (index // 36, (index // 6) % 6, index % 6))
    level = 8 + (index - 232) * 10
    return f"{level:02x}" * 3


class Session:
    def __init__(self, argv: list[str], cwd: Path, env: dict[str, str], cols: int, rows: int) -> None:
        self.master, slave = os.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        self.process = subprocess.Popen(
            argv, cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True,
            preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0),
        )
        os.close(slave)
        self.start = time.monotonic()
        self.events: list[tuple[float, str]] = []
        self.marks: dict[str, float] = {}
        self.pending = b""
        self.decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self.last_output = self.start
        self.text = ""
        self.rng = random.Random(7)

    def now(self) -> float:
        return time.monotonic() - self.start

    def mark(self, name: str) -> None:
        self.marks[name] = round(self.now(), 3)

    def reply(self, match: re.Match[bytes]) -> None:
        if match.group(1) == b"10":
            os.write(self.master, f"\x1b]10;{osc_rgb(THEME['fg'])}\x07".encode())
        elif match.group(1) == b"11":
            os.write(self.master, f"\x1b]11;{osc_rgb(THEME['bg'])}\x07".encode())
        elif match.group(2) is not None:
            index = int(match.group(2))
            os.write(self.master, f"\x1b]4;{index};{osc_rgb(xterm_colour(index))}\x07".encode())
        else:
            os.write(self.master, b"\x1b[?62;22c")

    def pump(self, seconds: float) -> None:
        deadline = time.monotonic() + seconds
        while (left := deadline - time.monotonic()) > 0:
            ready, _, _ = select.select([self.master], [], [], min(left, 0.05))
            if not ready:
                continue
            try:
                data = os.read(self.master, 65536)
            except OSError:
                return
            if not data:
                return
            self.last_output = time.monotonic()
            buffer = self.pending + data
            end = 0
            for match in QUERY.finditer(buffer):
                self.reply(match)
                end = match.end()
            self.pending = buffer[end:][-32:]
            chunk = self.decoder.decode(data)
            if chunk:
                self.events.append((self.now(), chunk))
                self.text += ANSI.sub("", chunk)

    def wait_quiet(self, quiet: float = 0.8, minimum: float = 0.5, limit: float = 30.0) -> None:
        begin = time.monotonic()
        while time.monotonic() - begin < limit:
            self.pump(0.1)
            elapsed = time.monotonic() - begin
            if elapsed >= minimum and time.monotonic() - self.last_output >= quiet:
                return
        raise TimeoutError(f"no quiet period within {limit}s")

    def wait_for(self, pattern: str, since: int, limit: float = 30.0) -> None:
        regex = re.compile(pattern)
        begin = time.monotonic()
        while time.monotonic() - begin < limit:
            self.pump(0.05)
            if regex.search(self.text, since):
                return
        raise TimeoutError(f"{pattern!r} did not appear within {limit}s")

    def type(self, text: str) -> None:
        for char in text:
            os.write(self.master, char.encode())
            self.pump(self.rng.uniform(0.04, 0.085))

    def key(self, sequence: str) -> None:
        os.write(self.master, sequence.encode())


def project(home: Path) -> Path:
    target = home / "pi-precompact"
    target.mkdir(parents=True)
    for name in ("src", "test"):
        shutil.copytree(ROOT / name, target / name)
    shutil.copy2(ROOT / "README.md", target / "README.md")
    subprocess.run(["git", "init", "-q", "-b", "main", str(target)], check=True)
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pi", default=shutil.which("pi") or "pi", help="Pi 1.4.0 executable")
    parser.add_argument("--out", required=True, type=Path, help="output path without extension")
    parser.add_argument("--cols", type=int, default=120)
    parser.add_argument("--rows", type=int, default=30)
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="precompact-demo-") as temp:
        # Resolve /var -> /private/var so Pi shortens the project path to ~.
        home = Path(os.path.realpath(temp)) / "home"
        agent = home / ".pi" / "agent"
        agent.mkdir(parents=True)
        (agent / "settings.json").write_text(json.dumps(SCENARIO["settings"], indent=2), encoding="utf-8")
        cwd = project(home)
        env = {
            "HOME": str(home),
            "PI_CODING_AGENT_DIR": str(agent),
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "TERM": "xterm-256color",
            "COLORTERM": "truecolor",
            "LANG": "en_US.UTF-8",
            "PI_OFFLINE": "1",
            "PI_SKIP_VERSION_CHECK": "1",
            "PI_TELEMETRY": "0",
        }
        model = SCENARIO["model"]
        argv = [
            args.pi, "--no-session",
            "-e", str(ROOT / "demo" / "scripted-model.ts"),
            "-e", str(ROOT / "src" / "index.ts"),
            "--model", f"{model['provider']}/{model['id']}",
        ]
        session = Session(argv, cwd, env, args.cols, args.rows)
        failure: BaseException | None = None
        try:
            session.wait_quiet(quiet=1.0, minimum=2.0)
            for index, turn in enumerate(SCENARIO["turns"]):
                since = len(session.text)
                session.type(turn["prompt"])
                session.pump(0.5)
                session.key("\r")
                session.mark(f"prompt{index + 1}")
                if index == 0:
                    session.wait_for(r"↑", since)
                    session.mark("measured")
                session.wait_quiet(quiet=1.2, minimum=1.0)
                session.mark(f"answer{index + 1}")
                if index == 2:
                    session.wait_for(r"pre running", since, limit=10)
                    session.mark("running")
                    session.pump(0.8)
                elif index == 3:
                    session.wait_for(r"→ ~", since, limit=40)
                    session.mark("ready")
                    session.pump(2.5)
                elif index == 4:
                    session.wait_for(r"Background summary applied", since, limit=30)
                    session.mark("applied")
                    session.pump(3.5)
                else:
                    session.pump(1.2)
            session.type("/precompact")
            session.pump(0.4)
            session.key("\r")
            session.mark("card")
            session.pump(5.0)
            session.key("\x1b")
            session.pump(1.0)
            session.mark("card_closed")
            session.type("/precompact off")
            session.pump(0.4)
            session.key("\r")
            session.pump(2.0)
            session.mark("off")
            session.pump(0.5)
            session.mark("end")
        except (TimeoutError, OSError) as error:
            # Keep the partial recording for diagnosis.
            session.mark("error")
            failure = error
        finally:
            session.key("\x04")
            session.pump(1.0)
            if session.process.poll() is None:
                session.process.terminate()
                session.process.wait(timeout=5)

    header = {
        "version": 2,
        "width": args.cols,
        "height": args.rows,
        "title": "pi-precompact",
        "env": {"TERM": "xterm-256color"},
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.with_suffix(".cast").open("w", encoding="utf-8") as cast:
        cast.write(json.dumps(header) + "\n")
        for moment, chunk in session.events:
            cast.write(json.dumps([round(moment, 6), "o", chunk], ensure_ascii=False) + "\n")
    args.out.with_suffix(".marks.json").write_text(json.dumps(session.marks, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(session.marks))
    if failure is not None:
        raise SystemExit(f"recording incomplete: {failure}")


if __name__ == "__main__":
    main()
