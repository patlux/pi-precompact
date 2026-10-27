/**
 * Motion helpers and texture components adapted from claude-motion
 * (https://github.com/whaleyxbt/claude-motion, commit e627941, MIT, see LICENSE.claude-motion):
 * easing curves, tweens, springs, deterministic noise, masked text, grain and the background.
 * Colours follow Pi's dark theme instead of the toolkit's coral.
 */
import type React from "react";
import { AbsoluteFill, Easing, type SpringConfig, spring, useVideoConfig } from "remotion";

export const C = {
  bg: "#17181b",
  window: "#2c2e33",
  chrome: "#232429",
  line: "rgba(226,226,227,0.10)",
  text: "#e2e2e3",
  dim: "rgba(226,226,227,0.62)",
  muted: "rgba(226,226,227,0.38)",
  // Pi's accent: the plugin's start mark and the running state.
  accent: "#b39df3",
};

export const F = {
  serif: '"Instrument Serif", Georgia, serif',
  sans: '"Inter Variable", Inter, system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, monospace',
};

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

export const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
export const easeIn = Easing.bezier(0.6, 0, 0.9, 0.35);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);

/** 0..1 progress of `t` between t0 and t1 through an easing curve. */
export const prog = (t: number, t0: number, t1: number, ease: (x: number) => number = easeInOut) =>
  ease(clamp01((t - t0) / (t1 - t0)));

/** A spring that starts at `startSec`. */
export const sp = (frame: number, startSec: number, fps: number, config: Partial<SpringConfig> = {}) => {
  const local = frame - startSec * fps;
  if (local <= 0) return 0;
  return spring({ frame: local, fps, config: { damping: 14, mass: 0.8, stiffness: 140, ...config } });
};

/** Deterministic pseudo-random in [0,1). */
export const rand = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** Masked word reveal: `k` 0→1 slides the content up into view, `out` 0→1 slides it on and out. */
export const Mask: React.FC<{
  k: number;
  out?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ k, out = 0, children, style }) => (
  <span
    style={{
      display: "inline-block",
      overflow: "hidden",
      verticalAlign: "bottom",
      padding: "0.06em 0.06em 0.16em",
      margin: "-0.06em -0.06em -0.16em",
    }}
  >
    <span
      style={{
        display: "inline-block",
        transform: `translateY(${(1 - k - out) * 118}%) rotate(${(1 - k) * 5}deg)`,
        transformOrigin: "0% 100%",
        ...style,
      }}
    >
      {children}
    </span>
  </span>
);

/** Animated film grain, reseeded on twos. */
export const Grain: React.FC<{ frame: number; opacity?: number }> = ({ frame, opacity = 0.06 }) => {
  const { width, height } = useVideoConfig();
  return (
    <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "overlay", opacity }}>
      <svg width={width} height={height} aria-hidden="true">
        <filter id="grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.85"
            numOctaves={2}
            seed={Math.floor(frame / 2) % 97}
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width={width} height={height} filter="url(#grain)" />
      </svg>
    </AbsoluteFill>
  );
};

/** A drifting dot grid, a soft glow behind the focus and a vignette. */
export const Background: React.FC<{ t: number; glow: number; glowX: number; glowY: number }> = ({
  t,
  glow,
  glowX,
  glowY,
}) => {
  const { width, height } = useVideoConfig();
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse 55% 50% at ${glowX}% ${glowY}%, rgba(179,157,243,${
            0.03 + 0.1 * glow
          }) 0%, rgba(179,157,243,0) 70%)`,
        }}
      />
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }} aria-hidden="true">
        <defs>
          <pattern
            id="dots"
            width="36"
            height="36"
            patternUnits="userSpaceOnUse"
            patternTransform={`translate(${-t * 4} ${-t * 7})`}
          >
            <circle cx="18" cy="18" r="1.15" fill="rgba(226,226,227,0.10)" />
          </pattern>
          <radialGradient id="gridFade" cx="50%" cy="50%" r="60%">
            <stop offset="0%" stopColor="#fff" stopOpacity="1" />
            <stop offset="75%" stopColor="#fff" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <mask id="gridMask">
            <rect width={width} height={height} fill="url(#gridFade)" />
          </mask>
        </defs>
        <rect width={width} height={height} fill="url(#dots)" mask="url(#gridMask)" />
      </svg>
      <AbsoluteFill
        style={{
          background: "radial-gradient(ellipse 85% 85% at 50% 50%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.55) 100%)",
        }}
      />
    </AbsoluteFill>
  );
};
