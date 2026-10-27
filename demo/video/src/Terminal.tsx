import type React from "react";
import storyboard from "../storyboard.json";
import { C, F } from "./motion";
import type { Screen } from "./types";

// Terminal geometry in window pixels. JetBrains Mono advances 0.6 em per cell.
export const FONT = 24;
export const CELL = FONT * 0.6;
export const ROW = 30;
export const PAD_X = 24;
export const PAD_Y = 16;
export const TITLE_BAR = 44;

export const windowSize = (cols: number, rows: number) => ({
  width: cols * CELL + 2 * PAD_X,
  height: TITLE_BAR + rows * ROW + 2 * PAD_Y,
});

export const cellX = (col: number) => PAD_X + col * CELL;
export const cellY = (row: number) => TITLE_BAR + PAD_Y + row * ROW;

/** One recorded screen, each run at its exact cell position. */
export const Terminal: React.FC<{ screen: Screen; cols: number; rows: number }> = ({
  screen,
  cols,
  rows,
}) => {
  const { width, height } = windowSize(cols, rows);
  return (
    <div
      style={{
        position: "absolute",
        width,
        height,
        borderRadius: 18,
        overflow: "hidden",
        background: storyboard.theme.bg,
        boxShadow: `0 0 0 1px ${C.line}, 0 40px 120px rgba(0,0,0,0.55)`,
      }}
    >
      <div
        style={{
          height: TITLE_BAR,
          background: C.chrome,
          borderBottom: `1px solid ${C.line}`,
          display: "flex",
          alignItems: "center",
          padding: "0 18px",
          gap: 9,
        }}
      >
        {[0, 1, 2].map((dot) => (
          <div
            key={dot}
            style={{ width: 13, height: 13, borderRadius: 7, background: "rgba(226,226,227,0.16)" }}
          />
        ))}
        <div
          style={{
            flex: 1,
            textAlign: "center",
            fontFamily: F.mono,
            fontSize: 16,
            color: C.muted,
            marginRight: 66,
          }}
        >
          pi — ~/pi-precompact
        </div>
      </div>
      {screen
        .flatMap((runs, row) => runs.map((run) => ({ id: `${row}:${run[0]}`, row, run })))
        .map(({ id, row, run: [col, cells, text, fg, bg, flags] }) => (
          <span
            key={id}
            style={{
              position: "absolute",
              left: cellX(col),
              top: cellY(row),
              width: cells * CELL,
              height: ROW,
              lineHeight: `${ROW}px`,
              fontFamily: F.mono,
              fontSize: FONT,
              fontWeight: flags & 1 ? 700 : 400,
              fontStyle: flags & 2 ? "italic" : "normal",
              textDecoration: flags & 4 ? "underline" : "none",
              opacity: flags & 8 ? 0.6 : 1,
              color: fg ?? storyboard.theme.fg,
              background: bg ?? "transparent",
              whiteSpace: "pre",
              fontVariantLigatures: "none",
              fontFeatureSettings: '"liga" 0, "calt" 0',
            }}
          >
            {text}
          </span>
        ))}
    </div>
  );
};
