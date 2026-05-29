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

export const ANSWER_SECONDS = 30;
export const READ_SECONDS = 180;

/* ----------------------------- technicality ----------------------------- */

export const TECH_MIN = 1;
export const TECH_MAX = 10;
export const TECH_DEFAULT = 5;

/** Short label shown next to the slider. */
export function technicalityLabel(n: number): string {
  if (n <= 2) return "Plain & simple";
  if (n <= 4) return "Beginner-friendly";
  if (n <= 6) return "Standard";
  if (n <= 8) return "Advanced";
  return "Expert / research-level";
}

/** The instruction handed to the model for a given slider value. */
export function technicalityPrompt(n: number): string {
  if (n <= 2)
    return "Explain in plain, everyday language a curious child could follow — short sentences, vivid analogies, and no jargon at all.";
  if (n <= 4)
    return "Explain in beginner-friendly terms with minimal jargon, defining any necessary terms and leaning on everyday analogies.";
  if (n <= 6)
    return "Write a clear, well-structured explanation for a general adult reader, introducing key terms as they come up.";
  if (n <= 8)
    return "Write an advanced explanation that uses correct domain terminology and engages with nuance, assuming some background.";
  return "Write a rigorous, research-level explanation with precise technical vocabulary and real depth, assuming strong domain familiarity.";
}

export const colorOf = (id: number) => COLORS[id % COLORS.length];
