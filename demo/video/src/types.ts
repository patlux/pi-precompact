/** A run of equally styled cells: column, cells, text, foreground, background, flags (1 bold, 2 italic, 4 underline, 8 dim). */
export type Run = [number, number, string, string | null, string | null, number];
export type Screen = Run[][];

export interface Screens {
  cols: number;
  rows: number;
  /** Source time of each screen change, in seconds. */
  times: number[];
  /** Screen shown from the matching time on. */
  index: number[];
  screens: Screen[];
}

/** Terminal cells to focus; `window` means the whole terminal window. */
export interface Rect {
  col0: number;
  col1: number;
  row0: number;
  row1: number;
  window?: boolean;
}

export interface Overlay {
  kind: "marks" | "running" | "ready" | "notice";
  row: number;
  col0?: number;
  col1?: number;
  colour?: string;
  marks?: { col: number; colour: string; text: string }[];
}

export interface Caption {
  key: string;
  label: string;
  /** Words between asterisks are the accent. */
  text: string;
}

export interface Segment {
  id: string;
  filmStart: number;
  filmEnd: number;
  sourceStart: number;
  sourceEnd: number;
  /** 0 freezes the source frame. */
  speed: number;
  shot: Rect;
  overlay: Overlay | null;
  caption: Caption | null;
  outro: boolean;
}

export interface Plan {
  duration: number;
  numbers: { start: string; threshold: string; expected: string };
  segments: Segment[];
}
