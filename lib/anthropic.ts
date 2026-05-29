import type { AnswerRecord, Lesson, Response, Verdict } from "./types";
import {
  scopePrompt,
  sizeMaxTokens,
  sizePrompt,
  technicalityPrompt,
} from "./constants";

export interface GenOptions {
  tech: number;
  scope: number;
  size: number;
  /**
   * Re-explanation intensity after an imperfect answer:
   * "light" (on the right track) = a bit fuller and clearer;
   * "deep"  (not quite)          = deeper and reasoning-first.
   */
  remediate?: "light" | "deep" | null;
}

/**
 * What just happened before this generation, injected so the AI knows the
 * context: the relationship to the prior lesson and how the learner actually
 * did. Used for branches, re-explanations, and sub-question dig-ins.
 */
export interface GenContext {
  /** "branch" (forward), "reexplain" (same topic), or "sub" (dig-in). */
  kind: "branch" | "reexplain" | "sub";
  /** The lesson this came from. */
  fromTitle: string;
  fromExplanation: string;
  fromQuestion: string;
  /** What the learner said and how it was judged on that prior question. */
  learnerAnswer: string;
  verdict: Verdict;
  feedback: string;
}

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

// Transient HTTP statuses worth retrying (rate limit, overloaded, gateway).
const RETRYABLE = new Set([408, 429, 500, 502, 503, 529]);
const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Round-trip to the Messages API with retry + backoff on transient failures
 * (a 429 rate-limit or a 529 "overloaded" — common on back-to-back Opus calls).
 * Returns the concatenated text.
 */
async function callClaude(
  apiKey: string,
  prompt: string,
  maxTokens: number = MAX_TOKENS
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const last = attempt === MAX_ATTEMPTS;
    const backoff = 700 * attempt; // 700ms, 1400ms

    let res: globalThis.Response;
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
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
      });
    } catch {
      if (!last) {
        await sleep(backoff);
        continue;
      }
      throw new AnthropicError(
        "network",
        "Couldn't reach Anthropic — check your connection and try again."
      );
    }

    // 401 is never retryable.
    if (res.status === 401) {
      throw new AnthropicError(
        "auth",
        "That key was rejected — check it and try again."
      );
    }

    if (RETRYABLE.has(res.status)) {
      if (!last) {
        await sleep(backoff);
        continue;
      }
      if (res.status === 429) {
        throw new AnthropicError(
          "rate",
          "Hit a rate limit (or this key is out of credit) — wait a moment and try again."
        );
      }
      throw new AnthropicError(
        "network",
        `Anthropic is busy right now (error ${res.status}) — give it another moment and retry.`
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
      if (!last) {
        await sleep(backoff);
        continue;
      }
      throw new AnthropicError(
        "parse",
        "Got a malformed response — give it another go."
      );
    }

    const text = (data.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");

    // An empty body is treated as transient (a hiccup) and retried.
    if (!text.trim() && !last) {
      await sleep(backoff);
      continue;
    }
    return text;
  }
  // Unreachable, but satisfies the type checker.
  throw new AnthropicError("network", "Couldn't reach Anthropic — try again.");
}

/** Strip ```json / ``` fences, then JSON.parse — tolerating stray prose. */
function parseJson<T>(raw: string): T {
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Some replies wrap the JSON in a sentence or two — extract the object.
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        /* fall through */
      }
    }
    throw new AnthropicError(
      "parse",
      "The model's reply wasn't readable — give it another go."
    );
  }
}

/* --------------------------- prompt builders --------------------------- */

function buildContextBlock(ctx: GenContext): string {
  const transcript = `Earlier, the learner studied "${ctx.fromTitle}".
That explanation was: """${ctx.fromExplanation}"""
They were asked: "${ctx.fromQuestion}"
They answered: """${ctx.learnerAnswer.trim() || "(left blank)"}"""
That answer was judged "${ctx.verdict}", with this feedback: "${ctx.feedback}"`;

  if (ctx.kind === "sub") {
    return `CONTEXT — the learner is pausing the lesson above to dig into a smaller sub-question first, because they did not fully get it:
${transcript}

Use this to pitch the sub-question explanation: target the specific gap their answer revealed, and lay the groundwork that will help them return and nail the original question. Still make the explanation stand on its own.`;
  }
  if (ctx.kind === "reexplain") {
    return `CONTEXT — this is a re-explanation of the SAME topic, because the learner's first attempt fell short:
${transcript}

Directly address where their answer went wrong or fell short — don't just repeat the previous explanation in different words; close the specific gap it reveals.`;
  }
  // branch
  return `CONTEXT — this branches forward from what the learner just grasped:
${transcript}

Connect to it in a sentence so the thread is continuous, then make the new explanation stand on its own.`;
}

function buildExplainPrompt(
  topic: string,
  opts: GenOptions,
  context: GenContext | null
): string {
  return `You are the engine of a study loop: the learner picks a topic, you explain it, then you pose one question that tests whether they grasped the core idea.

Topic: "${topic}"
${context ? "\n" + buildContextBlock(context) + "\n" : ""}
Follow all three of these dials:
- Technicality (${opts.tech}/10): ${technicalityPrompt(opts.tech)}
- Scope (${opts.scope}/10): ${scopePrompt(opts.scope)}
- Length (${opts.size}/10): ${sizePrompt(opts.size)}

${
  opts.remediate === "deep"
    ? `The learner just tried to explain this back and did NOT get the core idea. Go somewhat deeper than the length dial alone implies, and foreground the REASONING: walk through the causal why and how step by step — the chain of logic that makes the central idea click — rather than just stating facts or definitions.
`
    : opts.remediate === "light"
      ? `The learner was on the right track but didn't fully nail the core idea. Give a slightly fuller and clearer explanation than usual, adding a little more detail and a crisper through-line that sharpens and reinforces the central idea they nearly had.
`
      : ""
}
1. Explain the topic, obeying the technicality, scope, and length dials above. The explanation must stand alone and build logically.
2. Pose ONE open-ended question testing whether the reader grasped the CENTRAL idea — a "why", "explain", or "what would happen if" question, never a lookup of an exact figure or name.
3. List 1-3 short key points a correct answer must convey.

Respond with ONLY valid JSON, no preamble and no code fences:
{"title":"2-4 word title","explanation":"...","question":"...","keyPoints":["...",...]}`;
}

function buildRespondPrompt(p: {
  explanation: string;
  question: string;
  keyPoints: string[];
  answer: string;
}): string {
  return `You are grading a learner's free-text answer in a study loop, and steering where they go next. Be warm and encouraging. Focus ONLY on whether the core idea is conveyed — ignore grammar, spelling, and phrasing.

What they studied (reference): ${p.explanation}
Question: ${p.question}
Key ideas a correct answer must convey: ${p.keyPoints.join(" | ") || "(use your judgement)"}
Learner's answer: """${p.answer.trim() || "(left blank)"}"""

1. Judge whether they got the core idea (be lenient on wording).
2. Write 2-3 warm sentences of feedback: what they got, and the core idea if they missed it. If the answer is blank, gently state the idea they were reaching for.
3. Propose nextBranch: a short topic (2-6 words) naming a natural next thing to explore that branches slightly outward from this one — the curiosity this answer should open up.

Respond with ONLY valid JSON, no fences:
{"verdict":"nailed it" | "on the right track" | "not quite","feedback":"...","nextBranch":"short topic"}`;
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

function buildSuggestPrompt(history: AnswerRecord[]): string {
  const transcript = history
    .map(
      (h, i) =>
        `${i + 1}. Topic: ${h.title}\n   Asked: ${h.question}\n   They answered: "${
          h.answer || "(left blank)"
        }"\n   Judged: ${h.verdict}`
    )
    .join("\n");
  return `You suggest what a learner should study next, based on how they did in a study session.

Here is the session — each item is a topic, the question they were asked, their answer, and how it was judged:
${transcript}

Suggest 2 (at most 3) topics worth looking into next. Lean on what their answers reveal: a misconception to shore up where they were shaky, the natural next concept after what they grasped, or an adjacent idea their answers kept reaching toward.
Each suggestion must:
- stand on its own (name the subject explicitly — no "it"/"that"/"this thing"),
- read like something you could hand to a tutor as a fresh topic,
- not be a near-duplicate of a topic already covered above.

Respond with ONLY valid JSON, no preamble and no code fences:
{"topics":["...","..."]}
If the session is too thin to suggest anything useful, return {"topics":[]}.`;
}

/* ------------------------------ API calls ------------------------------ */

export async function generateExplanation(
  apiKey: string,
  topic: string,
  opts: GenOptions,
  context: GenContext | null = null
): Promise<Lesson> {
  // A re-explanation bumps length on top of the size dial: deeper for a
  // "not quite", a touch fuller for "on the right track".
  const bump = opts.remediate === "deep" ? 2 : opts.remediate === "light" ? 1 : 0;
  const size = Math.min(10, opts.size + bump);
  const raw = await callClaude(
    apiKey,
    buildExplainPrompt(topic, { ...opts, size }, context),
    sizeMaxTokens(size)
  );
  const parsed = parseJson<Partial<Lesson>>(raw);
  if (!parsed.explanation || typeof parsed.explanation !== "string") {
    throw new AnthropicError(
      "parse",
      "That one didn't come through cleanly — give it another go, or tweak the topic."
    );
  }
  return {
    title: String(parsed.title || topic).trim(),
    explanation: String(parsed.explanation).trim(),
    question: String(parsed.question ?? "").trim(),
    keyPoints: Array.isArray(parsed.keyPoints)
      ? parsed.keyPoints.map((k) => String(k).trim()).filter(Boolean)
      : [],
  };
}

export async function respondToAnswer(
  apiKey: string,
  args: {
    explanation: string;
    question: string;
    keyPoints: string[];
    answer: string;
  }
): Promise<Response> {
  const raw = await callClaude(apiKey, buildRespondPrompt(args));
  const parsed = parseJson<Partial<Response>>(raw);
  const allowed: Verdict[] = ["nailed it", "on the right track", "not quite"];
  const verdict: Verdict = allowed.includes(parsed.verdict as Verdict)
    ? (parsed.verdict as Verdict)
    : "on the right track";
  return {
    verdict,
    feedback: String(parsed.feedback ?? "").trim(),
    nextBranch: String(parsed.nextBranch ?? "").trim(),
  };
}

export async function suggestTopics(
  apiKey: string,
  history: AnswerRecord[]
): Promise<string[]> {
  if (!history.length) return [];
  const raw = await callClaude(apiKey, buildSuggestPrompt(history));
  const parsed = parseJson<{ topics?: unknown }>(raw);
  if (!Array.isArray(parsed.topics)) return [];
  return parsed.topics
    .map((t) => String(t).trim())
    .filter(Boolean)
    .slice(0, 3);
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
