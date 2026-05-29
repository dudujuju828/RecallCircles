import type { Level } from "./types";

/** Circle palette — purely for visual variety, no semantic meaning. */
export const COLORS = [
  "#E4572E",
  "#F3A712",
  "#17A398",
  "#3D5A80",
  "#D81E5B",
  "#6A994E",
  "#7B2CBF",
];

export const HINT_BUDGET = 2;
export const ANSWER_SECONDS = 30;
export const READ_SECONDS = 180;

export const LEVELS: Record<
  Level,
  { label: string; n: number; desc: string }
> = {
  simple: {
    label: "Keep it simple",
    n: 5,
    desc: "plain, everyday language a curious beginner could follow",
  },
  standard: {
    label: "Standard",
    n: 6,
    desc: "clear, well-structured writing for a general adult reader",
  },
  deep: {
    label: "Go deep",
    n: 7,
    desc: "precise, higher-level vocabulary with real depth and nuance",
  },
};

export const colorOf = (id: number) => COLORS[id % COLORS.length];
