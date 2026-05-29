/** Accent palette — purely for visual variety, no semantic meaning. */
export const COLORS = [
  "#E4572E",
  "#F3A712",
  "#17A398",
  "#3D5A80",
  "#D81E5B",
  "#6A994E",
  "#7B2CBF",
];

export const ANSWER_SECONDS = 120;
export const READ_SECONDS = 180;

/* ----------------------------- technicality ----------------------------- */

// All three sliders share a 1–10 range.
export const SLIDER_MIN = 1;
export const SLIDER_MAX = 10;
export const TECH_MIN = SLIDER_MIN; // kept for back-compat
export const TECH_MAX = SLIDER_MAX;
export const TECH_DEFAULT = 5;
export const SCOPE_DEFAULT = 5;
export const SIZE_DEFAULT = 5;

/** Short label shown next to the technicality slider. */
export function technicalityLabel(n: number): string {
  if (n <= 2) return "Plain & simple";
  if (n <= 4) return "Beginner-friendly";
  if (n <= 6) return "Standard";
  if (n <= 8) return "Advanced";
  return "Expert / research-level";
}

/** The technicality instruction handed to the model — a monotonic 1–10 dial. */
export function technicalityPrompt(n: number): string {
  return `Pitch the vocabulary and conceptual depth to technicality ${n} on a strict 1–10 scale, where 1 is the plainest everyday language a curious child could follow (no jargon, vivid simple analogies) and 10 is rigorous, research-level prose with precise technical terminology and no hand-holding. Treat ${n} as an exact dial, not a band: a ${n} must read as distinctly more technical and assume more background than ${n - 1}, and less than ${n + 1}.`;
}

/** Scope: how broad vs. narrow the explanation is relative to the question. */
export function scopeLabel(n: number): string {
  if (n <= 2) return "Laser-focused";
  if (n <= 4) return "Focused";
  if (n <= 6) return "Balanced";
  if (n <= 8) return "Broad";
  return "Big picture";
}

export function scopePrompt(n: number): string {
  return `Set the breadth to scope ${n} on a strict 1–10 scale, where 1 answers only the exact question with zero extra context or tangents, and 10 is a wide-angle treatment that situates the question in its full context with many explicit connections to adjacent and related ideas. Treat ${n} as an exact dial, not a band: a ${n} must cover noticeably more surrounding context and more connections than ${n - 1}, and less than ${n + 1}.`;
}

/** Response size: how long the explanation should be. */
export function sizeLabel(n: number): string {
  if (n <= 2) return "Brief";
  if (n <= 4) return "Short";
  if (n <= 6) return "Medium";
  if (n <= 8) return "Detailed";
  return "In depth";
}

// A strictly-increasing length target for each of the 10 levels.
const SIZE_TARGETS = [
  "exactly 1 sentence",
  "2 sentences",
  "3 sentences",
  "4 sentences",
  "about 6 sentences",
  "about 8 sentences (one full paragraph)",
  "about 11 sentences across two short paragraphs",
  "about 15 sentences across three paragraphs",
  "about 20 sentences across four to five paragraphs",
  "a thorough deep dive of 26 or more sentences across six or more paragraphs",
];

export function sizePrompt(n: number): string {
  const t = SIZE_TARGETS[Math.max(1, Math.min(10, n)) - 1];
  return `Make the explanation ${t} long — length level ${n} on a strict 1–10 scale where every level is meaningfully longer than the one below.`;
}

/** Token budget for generation, scaled to the requested size. */
export function sizeMaxTokens(n: number): number {
  return Math.min(4096, 512 + n * 200);
}

export const colorOf = (id: number) => COLORS[id % COLORS.length];
