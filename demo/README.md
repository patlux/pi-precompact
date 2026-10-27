# Demo recording

The media in `docs/media/` come from a real Pi 1.4.0 terminal session with this plugin.
Nothing in this directory is part of the npm package.

- `scenario.json`: the prompts, the file each prompt reads, the scripted usage after each response, and the summary text.
- `scripted-model.ts`: a Pi extension that registers the local model `demo/scripted` with a 272k context window.
  It reads the scenario's files with Pi's real `read` tool and answers.
  It replaces the usage of each response with the scripted value, as the integration tests do.
  Background summary requests receive the scenario's summary. It uses no network and no credentials.
- `record.py`: runs Pi in a private pseudo-terminal of 120 × 30 cells, with a temporary HOME,
  a copy of this repository as the project, the plugin, and the scripted model.
  It types the prompts, opens the status card, and switches the plugin off.
  It writes an asciicast v2 file and the times of the main events.
  It answers Pi's colour queries with the theme in `record.py`, so the bar fades in from that background.
- `render.py`: renders the stills and the fade-in clip in `docs/media/` with agg; gifsicle crops the clip and ffmpeg
  writes the stills. Every image is a frame of the recording. Crops select terminal rows; the clip plays at half speed.
- `video/`: the Remotion film in `docs/media/precompact.mp4` and `precompact.gif`, cut from the same kind of recording.
  See [`video/README.md`](video/README.md).

## Record and render

Requirements: Pi 1.4.0, Python 3.9 or later, and Git. Rendering also needs agg, gifsicle, ffmpeg,
and the MesloLGS Nerd Font Mono and DejaVu fonts.

```sh
python3 demo/record.py --pi "$(command -v pi)" --out /tmp/precompact-demo/demo
python3 demo/render.py --cast /tmp/precompact-demo/demo.cast --out docs/media \
  --font-dir <MesloLGS Nerd Font directory> --font-dir <DejaVu fonts directory>
```

With Nix, `nix shell nixpkgs#asciinema-agg nixpkgs#gifsicle nixpkgs#ffmpeg-headless` supplies the tools.
The fonts are in `nixpkgs#nerd-fonts.meslo-lg` and `nixpkgs#dejavu_fonts`.

The timing of each run differs by a few milliseconds. The token values, states, and texts do not.
