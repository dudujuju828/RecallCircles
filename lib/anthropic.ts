import type { Grade, Level, Passage, Verdict } from "./types";
import { LEVELS } from "./constants";

/*
 * BYOK Anthropic client.
 *
 * Every call goes straight from the browser to the Anthropic API using the
 * user's own key. The key never touches our server, is never logged, and the
 * repo ships no key of its own. The CORS-enabling header
 * `anthropic-dangerous-direct-browser-access` is what makes the browser call
 * possible.
 */

// Default model. "claude-sonnet-4-6" is a cheaper, still-excellent alternative
// for this task — swap the string here to use it.
export const MODEL = "claude-opus-4-8";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 1024;

export type ErrorKind = "auth" | "rate" | "network" | "parse" | "unknown";

export class AnthropicError extends Error {
  kind: ErrorKind;
  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.name = "AnthropicError";
    this.kind = kind;
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof AnthropicError) return e.message;
  return "Something went wrong — give it another go.";
}

export function isAuthError(e: unknown): boolean {
  return e instanceof AnthropicError && e.kind === "auth";
}

/** Looks-like-a-key check used by the settings UI. */
export function looksLikeKey(key: string): boolean {
  return /^sk-ant-/.test(key.trim());
}

interface MessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

/** Single round-trip to the Messages API; returns the concatenated text. */
async function callClaude(apiKey: string, prompt: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    throw new AnthropicError(
      "network",
      "Couldn't reach Anthropic — check your connection and try again."
    );
  }

  if (res.status === 401) {
    throw new AnthropicError(
      "auth",
      "That key was rejected — check it and try again."
    );
  }
  if (res.status === 429) {
    throw new AnthropicError(
      "rate",
      "Hit a rate limit (or this key is out of credit) — wait a moment and retry."
    );
  }
  if (!res.ok) {
    throw new AnthropicError(
      "unknown",
      `Anthropic returned an error (${res.status}) — give it another go.`
    );
  }

  let data: MessagesResponse;
  try {
    data = (await res.json()) as MessagesResponse;
  } catch {
    throw new AnthropicError(
      "parse",
      "Got a malformed response — give it another go."
    );
  }

  return (data.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
}

/** Strip ```json / ``` fences, then JSON.parse. */
function parseJson<T>(raw: string): T {
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    throw new AnthropicError(
      "parse",
      "The model's reply wasn't readable — give it another go."
    );
  }
}

/* --------------------------- prompt builders --------------------------- */

function buildGeneratePrompt(topic: string, level: Level): string {
  const lv = LEVELS[level];
  return `You create material for a study game: the player reads a passage, rebuilds it from memory, then answers one question about it.

Topic: "${topic}"

1. Write a coherent passage of EXACTLY ${lv.n} sentences at this level: ${lv.desc}.
   - Order must carry meaning (chronological, causal, or building logic).
   - Each sentence must stand alone when shown by itself — avoid opening pronouns like "this/it/they" that only make sense beside the previous sentence.
2. Write ONE open-ended question testing whether the reader grasped the CENTRAL idea — a "why", "explain", or "what would happen if" question, never a lookup of an exact figure or name.
3. List 1-3 short key points a correct answer must convey.

Respond with ONLY valid JSON, no preamble and no code fences:
{"title":"2-4 word title","chunks":["sentence 1",...],"question":"...","keyPoints":["...",...]}
chunks must have EXACTLY ${lv.n} items in correct reading order.`;
}

function buildGradePrompt(p: {
  chunks: string[];
  question: string;
  keyPoints: string[];
  answer: string;
}): string {
  return `You are grading a learner's free-text answer to a comprehension question. Be warm and encouraging. Focus ONLY on whether the core idea is conveyed — ignore grammar, spelling, phrasing, and missing minor detail.

Passage (reference): ${p.chunks.join(" ")}
Question: ${p.question}
Key ideas a correct answer must convey: ${p.keyPoints.join(" | ") || "(use your judgement from the passage)"}
Learner's answer: """${p.answer.trim() || "(left blank)"}"""

If the answer is blank, gently state the key idea they were reaching for.
Respond with ONLY valid JSON, no fences:
{"verdict":"nailed it" | "on the right track" | "not quite","feedback":"2-3 warm sentences: what they got, and the core idea if they missed it"}`;
}

function buildSplitPrompt(dump: string, sourceTopic: string): string {
  return `You turn a messy brain-dump into a short list of clear, self-contained study questions.

The learner just studied: "${sourceTopic}"
Their raw dump of what they want to look into next:
"""${dump.trim()}"""

Turn this into clear, standalone questions, each of which could become its own study topic.
Rules:
- Each question must stand on its own — no "it", "that", or "this thing"; name the subject explicitly.
- Phrase each so it reads like something you could hand to a tutor as a fresh topic.
- Deduplicate near-identical ideas; drop anything incoherent or empty.
- Keep it tight: at most 6 questions.

Respond with ONLY valid JSON, no preamble and no code fences:
{"questions":["...","..."]}
If the dump is empty or yields nothing usable, return {"questions":[]}.`;
}

/* ------------------------------ API calls ------------------------------ */

export async function generatePassage(
  apiKey: string,
  topic: string,
  level: Level
): Promise<Passage> {
  const raw = await callClaude(apiKey, buildGeneratePrompt(topic, level));
  const parsed = parseJson<Partial<Passage>>(raw);
  if (
    !parsed.chunks ||
    !Array.isArray(parsed.chunks) ||
    parsed.chunks.length < 3
  ) {
    throw new AnthropicError(
      "parse",
      "That one didn't come through cleanly — give it another go, or tweak the topic."
    );
  }
  return {
    title: String(parsed.title || topic).trim(),
    chunks: parsed.chunks.map((s) => String(s).trim()),
    question: String(parsed.question ?? "").trim(),
    keyPoints: Array.isArray(parsed.keyPoints)
      ? parsed.keyPoints.map((k) => String(k).trim()).filter(Boolean)
      : [],
  };
}

export async function gradeAnswer(
  apiKey: string,
  args: {
    chunks: string[];
    question: string;
    keyPoints: string[];
    answer: string;
  }
): Promise<Grade> {
  const raw = await callClaude(apiKey, buildGradePrompt(args));
  const parsed = parseJson<Partial<Grade>>(raw);
  const allowed: Verdict[] = ["nailed it", "on the right track", "not quite"];
  const verdict: Verdict = allowed.includes(parsed.verdict as Verdict)
    ? (parsed.verdict as Verdict)
    : "on the right track";
  return { verdict, feedback: String(parsed.feedback ?? "").trim() };
}

export async function splitThoughts(
  apiKey: string,
  dump: string,
  sourceTopic: string
): Promise<string[]> {
  const raw = await callClaude(apiKey, buildSplitPrompt(dump, sourceTopic));
  const parsed = parseJson<{ questions?: unknown }>(raw);
  if (!Array.isArray(parsed.questions)) return [];
  return parsed.questions
    .map((q) => String(q).trim())
    .filter(Boolean)
    .slice(0, 6);
}
