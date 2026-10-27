import type React from "react";
import { useEffect, useState } from "react";
import {
  AbsoluteFill,
  continueRender,
  delayRender,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import plan from "./generated/plan.json";
import { Background, C, clamp01, easeIn, easeInOut, easeOut, F, Grain, lerp, Mask, prog, sp } from "./motion";
import { CELL, cellX, cellY, ROW, Terminal, windowSize } from "./Terminal";
import type { Overlay, Plan, Rect, Screens, Segment } from "./types";

const PLAN = plan as Plan;
// The terminal lives below the caption band.
const VIEW = { x: 80, y: 196, width: 1760, height: 846 };
const MOVE = 0.9;

function useScreens(): Screens | undefined {
  const [handle] = useState(() => delayRender("screens"));
  const [screens, setScreens] = useState<Screens>();
  useEffect(() => {
    fetch(staticFile("screens.json"))
      .then((response) => response.json())
      .then((data: Screens) => {
        setScreens(data);
        continueRender(handle);
      });
  }, [handle]);
  return screens;
}

function useFonts() {
  const [handle] = useState(() => delayRender("fonts"));
  useEffect(() => {
    Promise.all([
      document.fonts.load('400 24px "JetBrains Mono"'),
      document.fonts.load('700 24px "JetBrains Mono"'),
      document.fonts.load('400 60px "Instrument Serif"'),
      document.fonts.load('italic 400 60px "Instrument Serif"'),
      document.fonts.load('400 20px "Inter Variable"'),
    ]).then(() => continueRender(handle));
  }, [handle]);
}

const segmentIndex = (t: number) => {
  const i = PLAN.segments.findIndex((segment) => t < segment.filmEnd);
  return i === -1 ? PLAN.segments.length - 1 : i;
};

const sourceTime = (segment: Segment, t: number) =>
  segment.speed === 0
    ? segment.sourceStart
    : Math.min(segment.sourceEnd, segment.sourceStart + (t - segment.filmStart) * segment.speed);

function screenAt(screens: Screens, time: number) {
  let lo = 0;
  let hi = screens.times.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (screens.times[mid] <= time) lo = mid;
    else hi = mid - 1;
  }
  return screens.screens[screens.index[lo]];
}

interface Camera {
  scale: number;
  x: number;
  y: number;
  /** The focus rectangle in window pixels. */
  focus: { x: number; y: number; width: number; height: number };
}

function fit(rect: Rect, cols: number, rows: number): Camera {
  const size = windowSize(cols, rows);
  const margin = 16;
  const focus = rect.window
    ? { x: 0, y: 0, width: size.width, height: size.height }
    : {
        x: cellX(rect.col0) - margin,
        y: cellY(rect.row0) - margin,
        width: (rect.col1 - rect.col0 + 1) * CELL + 2 * margin,
        height: (rect.row1 - rect.row0 + 1) * ROW + 2 * margin,
      };
  const scale = Math.min(3, VIEW.width / focus.width, VIEW.height / focus.height);
  return {
    scale,
    x: VIEW.x + VIEW.width / 2 - (focus.x + focus.width / 2) * scale,
    y: VIEW.y + VIEW.height / 2 - (focus.y + focus.height / 2) * scale,
    focus,
  };
}

function camera(t: number, cols: number, rows: number): Camera {
  const i = segmentIndex(t);
  const segment = PLAN.segments[i];
  const to = fit(segment.shot, cols, rows);
  const from = i > 0 ? fit(PLAN.segments[i - 1].shot, cols, rows) : to;
  const k = prog(t, segment.filmStart, segment.filmStart + MOVE, easeInOut);
  const blend = (a: number, b: number) => lerp(a, b, k);
  return {
    scale: Math.exp(blend(Math.log(from.scale), Math.log(to.scale))),
    x: blend(from.x, to.x),
    y: blend(from.y, to.y),
    focus: {
      x: blend(from.focus.x, to.focus.x),
      y: blend(from.focus.y, to.focus.y),
      width: blend(from.focus.width, to.focus.width),
      height: blend(from.focus.height, to.focus.height),
    },
  };
}

/** Darkens everything outside the focus, more the closer the camera is. */
const Spotlight: React.FC<{ cam: Camera; wideScale: number }> = ({ cam, wideScale }) => {
  const amount = clamp01((cam.scale / wideScale - 1) / 0.5);
  if (amount <= 0.01) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: cam.x + cam.focus.x * cam.scale,
        top: cam.y + cam.focus.y * cam.scale,
        width: cam.focus.width * cam.scale,
        height: cam.focus.height * cam.scale,
        borderRadius: 16,
        boxShadow: `0 0 0 4000px rgba(12,13,15,${0.74 * amount})`,
        pointerEvents: "none",
      }}
    />
  );
};

/** Labels and outlines drawn in terminal coordinates, so they move with the camera. */
const Marks: React.FC<{
  overlay: Overlay;
  t: number;
  start: number;
  end: number;
  fps: number;
  frame: number;
}> = ({ overlay, t, start, end, fps, frame }) => {
  const out = prog(t, end - 0.2, end + 0.25, easeIn);
  if (overlay.kind === "marks" && overlay.marks) {
    return (
      <>
        {overlay.marks.map((mark, i) => {
          const k = prog(t, start + 0.35 + i * 0.25, start + 1.15 + i * 0.25, easeOut);
          const x = cellX(mark.col) + CELL / 2;
          const right = i === 0;
          return (
            <div key={mark.text} style={{ opacity: 1 - out }}>
              <div
                style={{
                  position: "absolute",
                  left: x - 0.5,
                  top: cellY(overlay.row) - ROW * 0.72 * k,
                  width: 1,
                  height: ROW * 0.72 * k,
                  background: mark.colour,
                }}
              />
              <div
                style={{
                  position: "absolute",
                  top: cellY(overlay.row) - ROW * 1.05,
                  left: right ? x - 8 : x + 8,
                  transform: right ? "translateX(-100%)" : undefined,
                  fontFamily: F.mono,
                  fontSize: 18,
                  lineHeight: "22px",
                  color: mark.colour,
                  whiteSpace: "nowrap",
                }}
              >
                <Mask k={k}>{mark.text}</Mask>
              </div>
            </div>
          );
        })}
      </>
    );
  }
  const hero = overlay.kind === "notice";
  const pop = sp(
    frame,
    start + (hero ? 0.55 : 0.3),
    fps,
    hero ? { damping: 8, stiffness: 200 } : { damping: 11, stiffness: 210, mass: 0.7 },
  );
  const breathe = hero ? 0 : 0.5 + 0.5 * Math.sin((t - start) * Math.PI * 1.4);
  const colour = hero ? C.accent : (overlay.colour ?? C.accent);
  const pad = 8;
  return (
    <div
      style={{
        position: "absolute",
        left: cellX(overlay.col0 ?? 0) - pad,
        top: cellY(overlay.row) - 3,
        width: ((overlay.col1 ?? 0) - (overlay.col0 ?? 0) + 1) * CELL + 2 * pad,
        height: ROW + 6,
        borderRadius: 8,
        border: `2px solid ${colour}`,
        boxShadow: `0 0 ${18 + 10 * breathe}px ${colour}55`,
        opacity: clamp01(pop) * (1 - out),
        transform: `scale(${lerp(1.35, 1, pop)})`,
      }}
    />
  );
};

interface CaptionGroup {
  key: string;
  label: string;
  text: string;
  start: number;
  end: number;
}

const captionGroups: CaptionGroup[] = PLAN.segments.reduce<CaptionGroup[]>((groups, segment) => {
  const caption = segment.caption;
  if (!caption) return groups;
  const last = groups.at(-1);
  if (last && last.key === caption.key && Math.abs(last.end - segment.filmStart) < 1e-3)
    last.end = segment.filmEnd;
  else groups.push({ ...caption, start: segment.filmStart, end: segment.filmEnd });
  return groups;
}, []);

/** Words of a caption; `*…*` marks the accent words. */
const words = (text: string) => {
  const result: { id: string; word: string; accent: boolean }[] = [];
  let accent = false;
  for (const part of text.split(/(\*)/)) {
    if (part === "*") accent = !accent;
    else
      for (const word of part.split(" ").filter(Boolean))
        result.push({ id: `${result.length}:${word}`, word, accent });
  }
  return result;
};

const Captions: React.FC<{ t: number }> = ({ t }) => (
  <>
    {captionGroups.map((group, g) => {
      const first = g === 0;
      // Exits take half an entrance; the next caption starts once this one has left.
      const out = prog(t, group.end, group.end + 0.32, easeIn);
      const begin = first ? group.start : group.start + 0.3;
      if (t < group.start - 0.01 || out >= 1) return null;
      const big = group.key === "intro";
      return (
        <div key={group.key} style={{ position: "absolute", left: 96, top: big ? 58 : 62 }}>
          <div
            style={{
              fontFamily: F.mono,
              fontSize: 17,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: C.muted,
              marginBottom: 10,
            }}
          >
            <Mask k={first ? 1 : prog(t, begin, begin + 0.6, easeOut)} out={out}>
              {group.label}
            </Mask>
          </div>
          <div
            style={{
              fontFamily: F.serif,
              fontSize: big ? 84 : 70,
              lineHeight: 1,
              letterSpacing: "-0.01em",
              color: C.text,
              whiteSpace: "nowrap",
            }}
          >
            {words(group.text).map(({ id, word, accent }, i) => {
              const at = begin + 0.08 + i * 0.09;
              const k = first ? 1 : prog(t, at, at + 0.8, easeOut);
              return (
                <span key={id}>
                  <Mask k={k} out={out} style={accent ? { fontStyle: "italic", color: C.accent } : undefined}>
                    {word}
                  </Mask>{" "}
                </span>
              );
            })}
          </div>
        </div>
      );
    })}
  </>
);

const SpeedTag: React.FC<{ t: number }> = ({ t }) => {
  const segment = PLAN.segments[segmentIndex(t)];
  if (segment.speed === 0 || (segment.speed > 0.75 && segment.speed < 1.5)) return null;
  const k = Math.min(
    prog(t, segment.filmStart, segment.filmStart + 0.3, easeOut),
    1 - prog(t, segment.filmEnd - 0.2, segment.filmEnd, easeIn),
  );
  const slow = segment.speed < 1;
  return (
    <div
      style={{
        position: "absolute",
        right: 96,
        top: 78,
        opacity: k,
        transform: `translateY(${(1 - k) * 10}px)`,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "9px 16px",
        borderRadius: 999,
        border: `1px solid ${C.line}`,
        background: "rgba(23,24,27,0.75)",
        fontFamily: F.mono,
        fontSize: 17,
        letterSpacing: "0.18em",
        color: C.dim,
      }}
    >
      <span style={{ color: C.text, letterSpacing: 0, fontSize: 20 }}>{`${segment.speed}×`}</span>
      {slow ? "SLOW MOTION" : "FAST-FORWARD"}
    </div>
  );
};

const Outro: React.FC<{ t: number; start: number }> = ({ t, start }) => {
  const k = (delay: number) => prog(t, start + 0.45 + delay, start + 1.25 + delay, easeOut);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", textAlign: "center" }}>
      <div
        style={{
          fontFamily: F.mono,
          fontSize: 18,
          letterSpacing: "0.24em",
          color: C.muted,
          marginBottom: 18,
        }}
      >
        <Mask k={k(0.1)}>PI 1.4.0 EXTENSION</Mask>
      </div>
      <div
        style={{ fontFamily: F.serif, fontSize: 132, lineHeight: 1, color: C.text, letterSpacing: "-0.02em" }}
      >
        <Mask k={k(0.2)}>pi-precompact</Mask>
      </div>
      <div
        style={{
          marginTop: 44,
          opacity: k(0.45),
          transform: `translateY(${(1 - k(0.45)) * 16}px)`,
          padding: "18px 30px",
          borderRadius: 14,
          border: `1px solid ${C.line}`,
          background: "rgba(44,46,51,0.85)",
          fontFamily: F.mono,
          fontSize: 32,
          color: C.text,
        }}
      >
        <span style={{ color: C.accent }}>$</span> pi install npm:pi-precompact
      </div>
      <div
        style={{
          marginTop: 34,
          opacity: k(0.7),
          fontFamily: F.sans,
          fontSize: 21,
          color: C.muted,
          lineHeight: 1.5,
        }}
      >
        Recorded in a real Pi 1.4.0 terminal. The model is scripted to reach the thresholds quickly.
        <br />
        github.com/patlux/pi-precompact
      </div>
    </AbsoluteFill>
  );
};

export const Film: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const screens = useScreens();
  useFonts();
  if (!screens) return null;
  const t = frame / fps;
  const segment = PLAN.segments[segmentIndex(t)];
  const screen = screenAt(screens, sourceTime(segment, t));
  const { cols, rows } = screens;
  const cam = camera(t, cols, rows);
  const wide = fit({ col0: 0, col1: cols - 1, row0: 0, row1: rows - 1, window: true }, cols, rows);
  const outro = PLAN.segments.find((s) => s.outro);
  const fade = outro ? prog(t, outro.filmStart, outro.filmStart + 0.6, easeInOut) : 0;
  const glowX = ((cam.x + (cam.focus.x + cam.focus.width / 2) * cam.scale) / 1920) * 100;
  const glowY = ((cam.y + (cam.focus.y + cam.focus.height / 2) * cam.scale) / 1080) * 100;
  return (
    <AbsoluteFill>
      <Background t={t} glow={clamp01(cam.scale / wide.scale - 1)} glowX={glowX} glowY={glowY} />
      <AbsoluteFill
        style={{ opacity: 1 - 0.88 * fade, filter: fade > 0 ? `blur(${12 * fade}px)` : undefined }}
      >
        <div
          style={{
            position: "absolute",
            transformOrigin: "0 0",
            transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.scale})`,
          }}
        >
          <Terminal screen={screen} cols={cols} rows={rows} />
          {segment.overlay && (
            <Marks
              overlay={segment.overlay}
              t={t}
              start={segment.filmStart}
              end={segment.filmEnd}
              fps={fps}
              frame={frame}
            />
          )}
        </div>
        <Spotlight cam={cam} wideScale={wide.scale} />
      </AbsoluteFill>
      {fade < 1 && (
        <AbsoluteFill style={{ opacity: 1 - fade }}>
          <Captions t={t} />
          <SpeedTag t={t} />
        </AbsoluteFill>
      )}
      {outro && t >= outro.filmStart && <Outro t={t} start={outro.filmStart} />}
      <Grain frame={frame} />
    </AbsoluteFill>
  );
};

export const durationInFrames = (fps: number) => Math.ceil(PLAN.duration * fps);
