import type { Piece } from "./types";

/** Fisher–Yates shuffle that guarantees a different order (when possible). */
export function shuffle(a: Piece[]): Piece[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  if (r.every((v, i) => v.id === a[i].id) && r.length > 1) return shuffle(a);
  return r;
}

/** First `n` words of a sentence, with an ellipsis if it was truncated. */
export const firstWords = (s: string, n = 5): string => {
  const words = s.split(/\s+/);
  const head = words.slice(0, n).join(" ");
  return head + (words.length > n ? "…" : "");
};

/** Seconds → m:ss */
export const fmt = (s: number): string =>
  `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
