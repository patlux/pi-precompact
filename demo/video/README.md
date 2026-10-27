# Film

`docs/media/precompact.mp4` and `docs/media/precompact.gif` are a 33-second cut of a recorded Pi session.
Nothing in this directory is part of the npm package.

The terminal content is not redrawn. `scripts/prepare.mjs` replays the bytes that Pi wrote during
`demo/record.py` through `@xterm/headless`, the terminal emulator of VS Code, and stores every distinct screen.
It skips states inside Pi's synchronized-output blocks, so no half-drawn frame appears.
Remotion draws each stored screen as text at its exact cell positions and adds a camera, a spotlight, captions,
outlines, and speed changes on top. The thresholds in the captions are read from the recorded status card.

- `recording/`: the asciicast and event marks from `demo/record.py`.
- `storyboard.json`: the cut. Each clip names a source range by recording marks, a speed, a shot, a caption,
  and an optional outline. A new recording keeps the cut aligned.
- `scripts/prepare.mjs`: writes `public/screens.json` and `src/generated/plan.json`.
- `src/`: the composition. `src/motion.tsx` adapts easing, springs, masked text, grain, and the background
  from [claude-motion](https://github.com/whaleyxbt/claude-motion) (MIT, `LICENSE.claude-motion`).
  The film follows its motion rules: one focal point per frame, exits at half an entrance, and reading holds of at least 1 s.
- `scripts/sheet.mjs`: contact sheets for the review loop, adapted from claude-motion.

## Render

Requirements: Node.js 22 and ffmpeg. Remotion downloads its own headless Chrome on the first render.
Remotion is free for individuals and companies of up to three people; see <https://www.remotion.dev/license>.

```sh
python3 ../record.py --out recording/demo   # optional: a new recording with the official Pi
npm ci
npm run plan
npm run draft            # half resolution
npm run sheet            # contact sheets in out/sheets/
npm run render           # out/precompact.mp4, 1920 × 1080, 30 fps
```

The published files are derived from `out/precompact.mp4`:

```sh
ffmpeg -i out/precompact.mp4 -c:v libx264 -preset slow -crf 24 -pix_fmt yuv420p -movflags +faststart -an ../../docs/media/precompact.mp4
ffmpeg -i out/precompact.mp4 -vf "fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" out/precompact.gif
gifsicle -O3 --lossy=60 out/precompact.gif -o ../../docs/media/precompact.gif
ffmpeg -ss 23.6 -i out/precompact.mp4 -frames:v 1 -vf "scale=1280:-1,crop=1280:640:0:12" ../../docs/media/social-preview.png
```
