"use client";

import { useEffect, useRef, useState } from "react";
import {
  ANSWER_SECONDS,
  COLORS,
  READ_SECONDS,
  SCOPE_DEFAULT,
  SIZE_DEFAULT,
  SLIDER_MAX,
  SLIDER_MIN,
  TECH_DEFAULT,
  scopeLabel,
  sizeLabel,
  technicalityLabel,
} from "@/lib/constants";
import { fmt } from "@/lib/utils";
import type { AnswerRecord, Phase, QueueItem, Response } from "@/lib/types";
import type { GenContext } from "@/lib/anthropic";
import {
  errorMessage,
  generateExplanation,
  isAuthError,
  respondToAnswer,
  splitThoughts,
  suggestTopics,
} from "@/lib/anthropic";
import {
  clearKey,
  cryptoId,
  loadKey,
  loadQueue,
  maskKey,
  saveKey,
  saveQueue,
} from "@/lib/storage";
import { useTTS } from "@/lib/useTTS";
import AnswerField from "./AnswerField";
import SettingsModal from "./SettingsModal";

const verdictColor = (v: string) =>
  v === "nailed it" ? "#6A994E" : v === "not quite" ? "#D85A47" : "#C7892B";

// A lesson we can return to after finishing a nested "sub-question" dig-in —
// including the dials it was generated with, so they're restored on return.
interface LessonSnapshot {
  title: string;
  explanation: string;
  question: string;
  keyPoints: string[];
  trail: string[];
  tech: number;
  scope: number;
  size: number;
}

export default function RecallCircles() {
  const [phase, setPhase] = useState<Phase>("input");
  const [topic, setTopic] = useState("");
  const [tech, setTech] = useState(TECH_DEFAULT);
  const [scope, setScope] = useState(SCOPE_DEFAULT);
  const [size, setSize] = useState(SIZE_DEFAULT);

  const [title, setTitle] = useState("");
  const [explanation, setExplanation] = useState("");
  const [question, setQuestion] = useState("");
  const [keyPoints, setKeyPoints] = useState<string[]>([]);
  // Breadcrumb of titles covered this session, so branches read as a chain.
  const [trail, setTrail] = useState<string[]>([]);

  const [response, setResponse] = useState("");
  const [timeLeft, setTimeLeft] = useState(ANSWER_SECONDS);
  // Current round's answer clock — doubles on each "give it another go".
  const [answerSeconds, setAnswerSeconds] = useState(ANSWER_SECONDS);
  const [readLeft, setReadLeft] = useState(READ_SECONDS);
  const [result, setResult] = useState<Response | null>(null);
  const [graderError, setGraderError] = useState(false);
  const [error, setError] = useState("");

  // Sub-question flow: a stack of lessons to come back to once a dig-in is nailed.
  const [stack, setStack] = useState<LessonSnapshot[]>([]);
  const [askingSub, setAskingSub] = useState(false);
  const [subText, setSubText] = useState("");
  // Independent dials for the sub-question being composed (not the main ones).
  const [subTech, setSubTech] = useState(TECH_DEFAULT);
  const [subScope, setSubScope] = useState(SCOPE_DEFAULT);
  const [subSize, setSubSize] = useState(SIZE_DEFAULT);

  // BYOK key state.
  const [apiKey, setApiKey] = useState("");
  const [remember, setRemember] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [authError, setAuthError] = useState("");

  // "Look into next" queue + reflect phase.
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [pendingQueueId, setPendingQueueId] = useState<string | null>(null);
  const [reflectInput, setReflectInput] = useState("");
  const [tidying, setTidying] = useState(false);
  const [tidied, setTidied] = useState<string[] | null>(null);

  // Every answered question this session — feeds the "suggest next" call.
  const [history, setHistory] = useState<AnswerRecord[]>([]);
  // AI-suggested topics to look into next, based on how they answered.
  const [suggested, setSuggested] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  // Opt-in selection: nothing is queued unless the user picks it.
  const [pickS, setPickS] = useState<Set<number>>(new Set());
  const [pickT, setPickT] = useState<Set<number>>(new Set());

  // First-touch voice-model download overlay (delayed so cached loads don't flash).
  const [showVoiceOverlay, setShowVoiceOverlay] = useState(false);
  const [voiceOverlayDismissed, setVoiceOverlayDismissed] = useState(false);

  const tts = useTTS();

  const responseRef = useRef("");
  const submittedRef = useRef(false);
  const readSettledRef = useRef(false);
  useEffect(() => {
    responseRef.current = response;
  }, [response]);

  // Load any remembered key + saved queue on first mount.
  useEffect(() => {
    const k = loadKey();
    if (k) {
      setApiKey(k);
      setSavedKey(k);
      setRemember(true);
    }
    setQueue(loadQueue());
  }, []);

  // Show the download overlay only if the load is taking real time (>400ms),
  // so a cached, near-instant load doesn't flash a screen.
  useEffect(() => {
    if (tts.loadingModel && !voiceOverlayDismissed) {
      const id = setTimeout(() => setShowVoiceOverlay(true), 400);
      return () => clearTimeout(id);
    }
    setShowVoiceOverlay(false);
    if (!tts.loadingModel) setVoiceOverlayDismissed(false);
  }, [tts.loadingModel, voiceOverlayDismissed]);

  /* ----------------------------- key actions ----------------------------- */
  function handleSaveKey(key: string, rememberIt: boolean) {
    setApiKey(key);
    setRemember(rememberIt);
    setAuthError("");
    if (rememberIt) {
      saveKey(key);
      setSavedKey(key);
    } else {
      clearKey();
      setSavedKey(null);
    }
    setShowSettings(false);
  }

  function handleForgetKey() {
    setApiKey("");
    setRemember(false);
    setSavedKey(null);
    setAuthError("");
    clearKey();
  }

  // Snapshot of what the learner just did, for injecting into the next prompt.
  function priorContext(kind: GenContext["kind"]): GenContext | null {
    if (!result) return null;
    return {
      kind,
      fromTitle: title,
      fromExplanation: explanation,
      fromQuestion: question,
      learnerAnswer: response,
      verdict: result.verdict,
      feedback: result.feedback,
    };
  }

  /* ------------------------ explain (generate lesson) --------------------- */
  // trailMode: "reset" = brand-new session, "push" = new branch/dig-in,
  // "keep" = re-explain the current topic (don't grow the trail).
  // dials are passed explicitly so a sub-question can use its own without
  // racing React state.
  async function runGenerate(
    targetTopic: string,
    context: GenContext | null,
    trailMode: "reset" | "push" | "keep",
    dials: { tech: number; scope: number; size: number },
    remediate: "light" | "deep" | null = null
  ) {
    const t = targetTopic.trim();
    if (!t) return;
    if (!apiKey.trim()) {
      setError("Add your Anthropic key to begin.");
      setShowSettings(true);
      return;
    }
    setPhase("loading");
    setError("");
    try {
      const lesson = await generateExplanation(
        apiKey,
        t,
        { ...dials, remediate },
        context
      );
      setTitle(lesson.title);
      setExplanation(lesson.explanation);
      setQuestion(lesson.question);
      setKeyPoints(lesson.keyPoints);
      setResult(null);
      if (trailMode === "reset") {
        setHistory([]); // new session — forget old Q&A
        setStack([]); // and drop any unfinished sub-question chain
        setAnswerSeconds(ANSWER_SECONDS);
      }
      setTrail((prev) => {
        if (trailMode === "reset") return [lesson.title];
        if (trailMode === "push") return [...prev, lesson.title];
        // "keep" — re-explaining the same topic; refresh the current crumb.
        return prev.length ? [...prev.slice(0, -1), lesson.title] : [lesson.title];
      });
      // A queued curiosity has now become a round — retire it.
      if (pendingQueueId) {
        removeFromQueue(pendingQueueId);
        setPendingQueueId(null);
      }
      setPhase("explain");
      if (tts.enabled) tts.speak(lesson.explanation);
    } catch (e) {
      setError(errorMessage(e));
      if (isAuthError(e)) {
        setAuthError("That key was rejected — check it and try again.");
        setShowSettings(true);
      }
      setPhase("input");
    }
  }

  function generateFromInput() {
    runGenerate(topic, null, "reset", { tech, scope, size });
  }

  function continueBranch() {
    const nb = result?.nextBranch?.trim();
    if (!nb) return;
    setTopic(nb);
    runGenerate(nb, priorContext("branch"), "push", { tech, scope, size });
  }

  // Re-explain the same topic after an imperfect answer: "light" = a touch
  // fuller (on the right track), "deep" = deeper + reasoning-first (not quite).
  // Injects the learner's actual answer + feedback so it targets the real gap.
  function reexplain(level: "light" | "deep") {
    runGenerate(topic, priorContext("reexplain"), "keep", { tech, scope, size }, level);
  }

  // Dig into a separate sub-question, remembering the current lesson (and its
  // dials) so we can return once the sub-question is nailed. Sub-questions can
  // nest and carry their own, independent dials + injected parent context.
  function askSubQuestion() {
    const sub = subText.trim();
    if (!sub) return;
    const ctx = priorContext("sub");
    setStack((s) => [
      ...s,
      { title, explanation, question, keyPoints, trail, tech, scope, size },
    ]);
    setAskingSub(false);
    setSubText("");
    // The sub-question's own dials become the current dials for this lesson.
    setTech(subTech);
    setScope(subScope);
    setSize(subSize);
    runGenerate(sub, ctx, "push", { tech: subTech, scope: subScope, size: subSize });
  }

  // Pop back to the lesson we were on before the sub-question, restoring its
  // dials too, to take another crack at the original question.
  function returnToOriginal() {
    const prev = stack[stack.length - 1];
    if (!prev) return;
    setStack((s) => s.slice(0, -1));
    setTitle(prev.title);
    setExplanation(prev.explanation);
    setQuestion(prev.question);
    setKeyPoints(prev.keyPoints);
    setTrail(prev.trail);
    setTech(prev.tech);
    setScope(prev.scope);
    setSize(prev.size);
    startQuestion(); // fresh attempt at the original question
  }

  /* ----------------------------- timed question ---------------------------- */
  // First question after an explanation resets to the base clock. "Give it
  // another go" passes doubleTime, which doubles the previous round's clock.
  function startQuestion(doubleTime = false) {
    tts.stop(); // the explanation gets hidden now — don't keep narrating it
    setResponse("");
    setResult(null);
    submittedRef.current = false;
    const secs = doubleTime ? answerSeconds * 2 : ANSWER_SECONDS;
    setAnswerSeconds(secs);
    setTimeLeft(secs);
    setPhase("question");
  }

  // READ countdown — auto-advances to the question at 0.
  useEffect(() => {
    if (phase !== "explain") return;
    readSettledRef.current = false;
    setReadLeft(READ_SECONDS);
    const iv = setInterval(() => {
      setReadLeft((t) => {
        if (t <= 1) {
          clearInterval(iv);
          if (!readSettledRef.current) {
            readSettledRef.current = true;
            startQuestion();
          }
          return 0;
        }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ANSWER countdown — auto-submits whatever is present at 0.
  useEffect(() => {
    if (phase !== "question") return;
    const iv = setInterval(() => {
      setTimeLeft((t) => {
        if (t <= 1) {
          clearInterval(iv);
          submitAnswer(responseRef.current);
          return 0;
        }
        return t - 1;
      });
    }, 1000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  async function submitAnswer(text: string) {
    if (submittedRef.current) return;
    submittedRef.current = true;
    setPhase("grading");
    setGraderError(false);
    let spoken = "";
    let verdict: Response["verdict"] = "on the right track";
    try {
      const r = await respondToAnswer(apiKey, {
        explanation,
        question,
        keyPoints,
        answer: text || "",
      });
      setResult(r);
      spoken = r.feedback;
      verdict = r.verdict;
    } catch (e) {
      if (isAuthError(e)) {
        setAuthError("That key was rejected — check it and try again.");
        setShowSettings(true);
      }
      // Couldn't verify — don't trap the user; let them retry or wrap up.
      setGraderError(true);
      const fallback =
        errorMessage(e) +
        " (Couldn't grade this one automatically — the key idea you were reaching for: " +
        (keyPoints.join("; ") || title) +
        ".)";
      setResult({
        verdict: "on the right track",
        feedback: fallback,
        nextBranch: "",
      });
      spoken = fallback;
    }
    // Remember this Q&A so wrap-up can suggest where to go next.
    setHistory((h) => [
      ...h,
      { title, question, answer: (text || "").trim(), verdict },
    ]);
    setPhase("respond");
    if (tts.enabled) tts.speak(spoken);
  }

  /* ------------------------------- reflect ------------------------------- */
  function startReflect() {
    tts.stop();
    setReflectInput("");
    setTidied(null);
    setTidying(false);
    setSuggested([]);
    setSuggesting(false);
    setPickS(new Set());
    setPickT(new Set());
    setPhase("reflect");
    // Pull a couple of "look into next" topics from how they answered.
    if (apiKey.trim() && history.length) runSuggest(history);
  }

  async function runSuggest(records: AnswerRecord[]) {
    setSuggesting(true);
    try {
      setSuggested(await suggestTopics(apiKey, records));
    } catch {
      setSuggested([]);
    }
    setSuggesting(false);
  }

  function toggleSuggested(idx: number) {
    setPickS((prev) => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  }

  function toggleTidied(idx: number) {
    setPickT((prev) => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  }

  function finishToInput() {
    tts.stop();
    setReflectInput("");
    setTidied(null);
    setTidying(false);
    setSuggested([]);
    setSuggesting(false);
    setPickS(new Set());
    setPickT(new Set());
    setHistory([]);
    setStack([]);
    setAskingSub(false);
    setSubText("");
    setAnswerSeconds(ANSWER_SECONDS);
    setTopic("");
    setTrail([]);
    setResult(null);
    setPendingQueueId(null);
    setError("");
    setPhase("input");
  }

  async function submitReflect() {
    const dump = reflectInput.trim();
    // Empty dump still advances to the review screen so the AI suggestions
    // can be saved.
    if (!dump) {
      setTidied([]);
      return;
    }
    if (!apiKey.trim()) {
      setTidied(dump.split(/\n+/).map((s) => s.trim()).filter(Boolean));
      return;
    }
    setTidying(true);
    try {
      const qs = await splitThoughts(apiKey, dump, title || topic);
      setTidied(qs);
    } catch {
      setTidied(dump.split(/\n+/).map((s) => s.trim()).filter(Boolean));
    }
    setTidying(false);
  }

  function saveReflect() {
    // Only the rows the user actually selected get queued.
    const chosen = [
      ...suggested.filter((_, i) => pickS.has(i)),
      ...(tidied || []).filter((_, i) => pickT.has(i)),
    ];
    const seen = new Set<string>();
    const texts: string[] = [];
    for (const text of chosen) {
      const key = text.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      texts.push(text.trim());
    }
    if (texts.length) {
      const additions: QueueItem[] = texts.map((text) => ({
        id: cryptoId(),
        text,
        createdAt: Date.now(),
        sourceTopic: title || topic,
      }));
      const next = [...additions, ...queue];
      setQueue(next);
      saveQueue(next);
    }
    finishToInput();
  }

  /* -------------------------------- queue -------------------------------- */
  function removeFromQueue(id: string) {
    setQueue((q) => {
      const next = q.filter((item) => item.id !== id);
      saveQueue(next);
      return next;
    });
  }

  function clearQueue() {
    setQueue([]);
    saveQueue([]);
  }

  function useQueueItem(item: QueueItem) {
    setTopic(item.text);
    setPendingQueueId(item.id);
    setError("");
  }

  const maskedHeaderKey = savedKey
    ? maskKey(savedKey)
    : apiKey
      ? "this session"
      : null;

  const speakButton = (text: string) =>
    tts.supported ? (
      <button
        className="rcb-btn"
        onClick={() => (tts.status === "speaking" ? tts.stop() : tts.speak(text))}
        style={{
          padding: "11px 18px",
          borderRadius: 12,
          fontSize: 14,
          fontWeight: 600,
          background: "#FFFDF8",
          color: "#17A398",
          boxShadow: "inset 0 0 0 1.5px #BfE3DE",
        }}
      >
        {tts.status === "speaking"
          ? "⏹ Stop"
          : tts.status === "loading"
            ? "🔊 Loading voice…"
            : "🔊 Listen"}
      </button>
    ) : null;

  const sliderControl = (
    label: string,
    value: number,
    onChange: (n: number) => void,
    valueLabel: string,
    leftCaption: string,
    rightCaption: string
  ) => (
    <div style={{ marginTop: 22 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <label
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "#5C5345",
            textTransform: "uppercase",
            letterSpacing: ".08em",
          }}
        >
          {label}
        </label>
        <span style={{ fontSize: 14, color: "#5C5345", fontWeight: 600 }}>
          {valueLabel} <span style={{ opacity: 0.6 }}>· {value}/10</span>
        </span>
      </div>
      <input
        type="range"
        min={SLIDER_MIN}
        max={SLIDER_MAX}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%", accentColor: "#E4572E", cursor: "pointer" }}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 4,
          fontSize: 12,
          color: "#9A8F7C",
        }}
      >
        <span>{leftCaption}</span>
        <span>{rightCaption}</span>
      </div>
    </div>
  );

  const selectedCount = pickS.size + pickT.size;

  // A tappable row that opts a question into the queue. Unselected by default —
  // you have to pick what you want saved.
  const pickRow = (
    key: string,
    text: string,
    picked: boolean,
    onToggle: () => void,
    accent: string
  ) => (
    <button
      key={key}
      type="button"
      className="rcb-btn"
      onClick={onToggle}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "14px 16px",
        borderRadius: 14,
        width: "100%",
        textAlign: "left",
        background: picked ? "#FFFDF8" : "#F3ECDD",
        boxShadow: picked
          ? `inset 0 0 0 2px ${accent}`
          : "inset 0 0 0 1.5px #E4D8C0",
        opacity: picked ? 1 : 0.72,
      }}
    >
      <span
        style={{
          flexShrink: 0,
          width: 24,
          height: 24,
          borderRadius: "50%",
          background: picked ? accent : "transparent",
          border: picked ? "none" : "1.5px solid #C9BBA0",
          color: "#fff",
          fontSize: 13,
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {picked ? "✓" : ""}
      </span>
      <span
        style={{
          flex: 1,
          fontFamily: "'Newsreader', serif",
          fontSize: 17,
          lineHeight: 1.4,
          color: "#2B241B",
        }}
      >
        {text}
      </span>
    </button>
  );

  const Breadcrumb = () =>
    trail.length > 0 ? (
      <p
        style={{
          fontSize: 13,
          color: "#9A8F7C",
          margin: "0 0 14px",
          fontWeight: 600,
        }}
      >
        {trail.map((t, i) => (
          <span key={i}>
            {i > 0 && <span style={{ opacity: 0.5 }}> › </span>}
            <span style={{ color: i === trail.length - 1 ? "#5C5345" : "#9A8F7C" }}>
              {t}
            </span>
          </span>
        ))}
      </p>
    ) : null;

  /* ------------------------------- shell -------------------------------- */
  return (
    <div
      className="rcb"
      style={{
        fontFamily: "'Hanken Grotesk', sans-serif",
        color: "#211B14",
        minHeight: "100%",
        padding: "32px 20px 64px",
        background:
          "radial-gradient(120% 90% at 15% -10%, #FBF7EE 0%, #F2EADB 55%, #ECE0CC 100%)",
      }}
    >
      <SettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
        apiKey={apiKey}
        remember={remember}
        savedKey={savedKey}
        authError={authError}
        onSave={handleSaveKey}
        onForget={handleForgetKey}
      />

      {showVoiceOverlay && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(33,27,20,.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            zIndex: 60,
            animation: "rcb-fadeup .25s both",
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 440,
              background: "#FBF7EE",
              borderRadius: 22,
              padding: "30px 28px",
              boxShadow: "0 30px 80px -30px rgba(33,27,20,.6)",
              border: "1px solid #E4D8C0",
              textAlign: "center",
            }}
          >
            <div style={{ display: "inline-flex", gap: 12, marginBottom: 20 }}>
              {COLORS.slice(0, 5).map((c, i) => (
                <span
                  key={c}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: "50%",
                    background: c,
                    animation: `rcb-bob 1s ${i * 0.12}s infinite ease-in-out`,
                  }}
                />
              ))}
            </div>
            <h2
              style={{
                fontFamily: "'Fraunces', serif",
                fontWeight: 900,
                fontSize: 22,
                margin: "0 0 8px",
              }}
            >
              Setting up the voice
            </h2>
            <p style={{ margin: "0 0 20px", color: "#7A6F5E", fontSize: 14, lineHeight: 1.5 }}>
              Downloading the high-quality neural voice — a one-time ~330&nbsp;MB, then it
              runs instantly on your GPU.
            </p>
            <div
              style={{
                height: 8,
                borderRadius: 4,
                background: "#E7DCC6",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${tts.loadProgress}%`,
                  background: "#17A398",
                  transition: "width .3s linear",
                }}
              />
            </div>
            <p
              style={{
                margin: "10px 0 0",
                fontFamily: "'Fraunces',serif",
                fontWeight: 600,
                fontSize: 15,
                color: "#5C5345",
              }}
            >
              {tts.loadProgress < 100
                ? `Downloading… ${tts.loadProgress}%`
                : "Preparing the voice…"}
            </p>
            <button
              className="rcb-btn"
              onClick={() => setVoiceOverlayDismissed(true)}
              style={{
                marginTop: 18,
                padding: "10px 18px",
                borderRadius: 12,
                fontSize: 14,
                fontWeight: 600,
                background: "#FFFDF8",
                color: "#5C5345",
                boxShadow: "inset 0 0 0 1.5px #D8CBB2",
              }}
            >
              Continue in background
            </button>
          </div>
        </div>
      )}

      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        {/* header */}
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 6,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <span style={{ display: "flex", gap: 5 }}>
              {COLORS.slice(0, 4).map((c) => (
                <span
                  key={c}
                  style={{ width: 12, height: 12, borderRadius: "50%", background: c }}
                />
              ))}
            </span>
            <h1
              style={{
                fontFamily: "'Fraunces', serif",
                fontWeight: 900,
                fontSize: 30,
                letterSpacing: "-0.02em",
                margin: 0,
              }}
            >
              Recall Circles
            </h1>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {tts.supported && (
              <button
                className="rcb-btn"
                onClick={tts.toggle}
                title={
                  tts.engine === "webgpu"
                    ? "Read responses aloud (local neural voice on your GPU)"
                    : "Read responses aloud (built-in browser voice)"
                }
                style={{
                  padding: "8px 14px",
                  borderRadius: 999,
                  fontSize: 13,
                  fontWeight: 600,
                  background: tts.enabled ? "#17A398" : "#FFFDF8",
                  color: tts.enabled ? "#fff" : "#5C5345",
                  boxShadow: tts.enabled
                    ? "0 4px 14px rgba(23,163,152,.3)"
                    : "inset 0 0 0 1.5px #D8CBB2",
                  animation:
                    tts.enabled && tts.status === "speaking"
                      ? "rcb-pulse 1.2s infinite"
                      : "none",
                }}
              >
                {tts.enabled
                  ? tts.status === "loading"
                    ? "🔊 loading voice…"
                    : "🔊 Voice on"
                  : "🔇 Voice off"}
              </button>
            )}
            <button
              className="rcb-btn"
              onClick={() => {
                setAuthError("");
                setShowSettings(true);
              }}
              style={{
                padding: "8px 14px",
                borderRadius: 999,
                fontSize: 13,
                fontWeight: 600,
                background: maskedHeaderKey ? "#FFFDF8" : "#211B14",
                color: maskedHeaderKey ? "#5C5345" : "#F7F1E5",
                boxShadow: maskedHeaderKey
                  ? "inset 0 0 0 1.5px #D8CBB2"
                  : "0 4px 14px rgba(33,27,20,.22)",
              }}
            >
              {maskedHeaderKey ? `🔑 ${maskedHeaderKey}` : "🔑 Add your key"}
            </button>
          </div>
        </div>
        <p style={{ margin: "0 0 8px", color: "#7A6F5E", fontSize: 15 }}>
          Pick a topic. Read the explanation. Answer back. Branch onward.
        </p>
        {tts.error ? (
          <p style={{ margin: "0 0 20px", color: "#C0392B", fontSize: 13 }}>
            🔇 {tts.error}
          </p>
        ) : (
          <div style={{ height: 20 }} />
        )}

        {/* ----------------------------- INPUT ----------------------------- */}
        {phase === "input" && (
          <div style={{ animation: "rcb-fadeup .4s both" }}>
            <label
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "#5C5345",
                textTransform: "uppercase",
                letterSpacing: ".08em",
              }}
            >
              What do you want to learn?
            </label>
            <input
              value={topic}
              onChange={(e) => {
                setTopic(e.target.value);
                if (pendingQueueId) setPendingQueueId(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && generateFromInput()}
              placeholder="e.g. how a black hole forms, the French Revolution, photosynthesis…"
              style={{
                width: "100%",
                marginTop: 10,
                padding: "16px 18px",
                fontSize: 17,
                fontFamily: "'Newsreader', serif",
                border: "1.5px solid #D8CBB2",
                borderRadius: 16,
                background: "#FFFDF8",
                outline: "none",
                color: "#211B14",
              }}
            />

            {/* generation dials */}
            {sliderControl(
              "How technical?",
              tech,
              setTech,
              technicalityLabel(tech),
              "Plain & everyday",
              "Research-level"
            )}
            {sliderControl(
              "Scope",
              scope,
              setScope,
              scopeLabel(scope),
              "Just the question",
              "Wider context"
            )}
            {sliderControl(
              "Response size",
              size,
              setSize,
              sizeLabel(size),
              "Brief",
              "In depth"
            )}

            {error && (
              <p style={{ color: "#C0392B", fontSize: 14, marginTop: 18 }}>{error}</p>
            )}
            <button
              className="rcb-btn"
              onClick={generateFromInput}
              disabled={!topic.trim()}
              style={{
                marginTop: 26,
                padding: "15px 30px",
                borderRadius: 14,
                fontSize: 16,
                fontWeight: 700,
                background: "#E4572E",
                color: "#fff",
                boxShadow: "0 8px 22px rgba(228,87,46,.35)",
              }}
            >
              Explain it →
            </button>

            {/* look-into-next queue */}
            {queue.length > 0 && (
              <div style={{ marginTop: 40 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: 12,
                    marginBottom: 12,
                  }}
                >
                  <p
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "#9A8F7C",
                      textTransform: "uppercase",
                      letterSpacing: ".1em",
                      margin: 0,
                    }}
                  >
                    Look into next — tap to start
                  </p>
                  <button
                    className="rcb-btn"
                    onClick={clearQueue}
                    style={{
                      background: "transparent",
                      color: "#9A8F7C",
                      fontSize: 13,
                      fontWeight: 600,
                      padding: 0,
                    }}
                  >
                    Clear all
                  </button>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                  {queue.map((item) => (
                    <span
                      key={item.id}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "9px 8px 9px 16px",
                        borderRadius: 999,
                        background: "#FFFDF8",
                        boxShadow: "inset 0 0 0 1.5px #E4D8C0",
                        maxWidth: "100%",
                      }}
                    >
                      <button
                        className="rcb-btn"
                        onClick={() => useQueueItem(item)}
                        style={{
                          background: "transparent",
                          color: "#5C5345",
                          fontSize: 14,
                          fontWeight: 500,
                          fontFamily: "'Newsreader', serif",
                          padding: 0,
                          textAlign: "left",
                          maxWidth: 340,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                        title={item.text}
                      >
                        {item.text}
                      </button>
                      <button
                        className="rcb-btn"
                        aria-label="Remove"
                        onClick={() => removeFromQueue(item.id)}
                        style={{
                          background: "transparent",
                          color: "#B6A98E",
                          fontSize: 16,
                          lineHeight: 1,
                          padding: "0 4px",
                          fontWeight: 700,
                        }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ----------------------------- LOADING ----------------------------- */}
        {(phase === "loading" || phase === "grading") && (
          <div style={{ textAlign: "center", padding: "60px 0" }}>
            <div style={{ display: "inline-flex", gap: 14, marginBottom: 24 }}>
              {COLORS.slice(0, 5).map((c, i) => (
                <span
                  key={c}
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: "50%",
                    background: c,
                    animation: `rcb-bob 1s ${i * 0.12}s infinite ease-in-out`,
                  }}
                />
              ))}
            </div>
            <p style={{ fontFamily: "'Fraunces', serif", fontSize: 20, color: "#5C5345" }}>
              {phase === "loading" ? "Writing your explanation…" : "Reading your answer…"}
            </p>
          </div>
        )}

        {/* ----------------------------- EXPLAIN ----------------------------- */}
        {phase === "explain" && (
          <div style={{ animation: "rcb-fadeup .45s both" }}>
            <Breadcrumb />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 12,
              }}
            >
              <p
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#9A8F7C",
                  textTransform: "uppercase",
                  letterSpacing: ".1em",
                  margin: 0,
                }}
              >
                Learn it — you&apos;ll be quizzed when time&apos;s up
              </p>
              <span
                style={{
                  fontFamily: "'Fraunces',serif",
                  fontWeight: 900,
                  fontSize: 22,
                  color: readLeft <= 30 ? "#D85A47" : "#5C5345",
                  animation: readLeft <= 30 ? "rcb-pulse 1s infinite" : "none",
                }}
              >
                {fmt(readLeft)}
              </span>
            </div>
            <div
              style={{
                height: 6,
                borderRadius: 3,
                background: "#E7DCC6",
                overflow: "hidden",
                marginBottom: 22,
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${(readLeft / READ_SECONDS) * 100}%`,
                  background: readLeft <= 30 ? "#D85A47" : "#17A398",
                  transition: "width 1s linear",
                }}
              />
            </div>
            <h2
              style={{
                fontFamily: "'Fraunces', serif",
                fontWeight: 600,
                fontSize: 26,
                margin: "0 0 20px",
              }}
            >
              {title}
            </h2>
            <div
              style={{
                fontFamily: "'Newsreader', serif",
                fontSize: 21,
                lineHeight: 1.65,
                color: "#2B241B",
                background: "#FFFDF8",
                border: "1px solid #E4D8C0",
                borderRadius: 20,
                padding: "30px 32px",
                boxShadow: "0 14px 40px -22px rgba(80,60,30,.35)",
              }}
            >
              {explanation}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                marginTop: 24,
                flexWrap: "wrap",
              }}
            >
              <button
                className="rcb-btn"
                onClick={() => {
                  if (!readSettledRef.current) {
                    readSettledRef.current = true;
                    startQuestion();
                  }
                }}
                style={{
                  padding: "15px 28px",
                  borderRadius: 14,
                  fontSize: 16,
                  fontWeight: 700,
                  background: "#211B14",
                  color: "#F7F1E5",
                  boxShadow: "0 8px 22px rgba(33,27,20,.3)",
                }}
              >
                I&apos;m ready — quiz me →
              </button>
              {speakButton(explanation)}
              <span style={{ fontSize: 14, color: "#9A8F7C" }}>
                Tap when you&apos;ve got it, or let the clock decide.
              </span>
            </div>
          </div>
        )}

        {/* ----------------------------- QUESTION (timed) ----------------------------- */}
        {phase === "question" && (
          <div style={{ animation: "rcb-fadeup .4s both" }}>
            <Breadcrumb />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 14,
              }}
            >
              <p
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "#9A8F7C",
                  textTransform: "uppercase",
                  letterSpacing: ".1em",
                  margin: 0,
                }}
              >
                In your own words
              </p>
              <span
                style={{
                  fontFamily: "'Fraunces',serif",
                  fontWeight: 900,
                  fontSize: 22,
                  color: timeLeft <= 10 ? "#D85A47" : "#5C5345",
                  animation: timeLeft <= 10 ? "rcb-pulse 1s infinite" : "none",
                }}
              >
                {timeLeft >= 60 ? fmt(timeLeft) : `${timeLeft}s`}
              </span>
            </div>
            <div
              style={{
                height: 6,
                borderRadius: 3,
                background: "#E7DCC6",
                overflow: "hidden",
                marginBottom: 22,
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${(timeLeft / answerSeconds) * 100}%`,
                  background: timeLeft <= 10 ? "#D85A47" : "#E4572E",
                  transition: "width 1s linear",
                }}
              />
            </div>
            <p
              style={{
                fontFamily: "'Fraunces', serif",
                fontWeight: 600,
                fontSize: 24,
                lineHeight: 1.35,
                margin: "0 0 18px",
              }}
            >
              {question}
            </p>
            <AnswerField
              value={response}
              setValue={setResponse}
              autoFocus
              placeholder="Type or speak your answer — just get the idea across…"
            />
            <button
              className="rcb-btn"
              onClick={() => submitAnswer(response)}
              style={{
                marginTop: 16,
                padding: "14px 28px",
                borderRadius: 14,
                fontSize: 16,
                fontWeight: 700,
                background: "#E4572E",
                color: "#fff",
                boxShadow: "0 8px 22px rgba(228,87,46,.35)",
              }}
            >
              Submit now
            </button>
          </div>
        )}

        {/* ----------------------------- RESPOND ----------------------------- */}
        {phase === "respond" && result && (
          <div style={{ animation: "rcb-fadeup .4s both" }}>
            <Breadcrumb />
            <span
              style={{
                display: "inline-block",
                padding: "6px 16px",
                borderRadius: 999,
                fontSize: 13,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: ".06em",
                color: "#fff",
                background: verdictColor(result.verdict),
              }}
            >
              {result.verdict}
            </span>
            <p
              style={{
                fontFamily: "'Newsreader', serif",
                fontSize: 20,
                lineHeight: 1.6,
                color: "#2B241B",
                margin: "16px 0 0",
              }}
            >
              {result.feedback}
            </p>

            {tts.supported && (
              <div style={{ marginTop: 14 }}>{speakButton(result.feedback)}</div>
            )}

            <div
              style={{
                marginTop: 26,
                background: "#FBF7EE",
                border: "1px solid #E4D8C0",
                borderRadius: 16,
                padding: "18px 22px",
              }}
            >
              <p
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "#9A8F7C",
                  textTransform: "uppercase",
                  letterSpacing: ".08em",
                  margin: "0 0 8px",
                }}
              >
                The question
              </p>
              <p style={{ fontFamily: "'Fraunces',serif", fontSize: 17, margin: "0 0 14px" }}>
                {question}
              </p>
              <p
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "#9A8F7C",
                  textTransform: "uppercase",
                  letterSpacing: ".08em",
                  margin: "0 0 8px",
                }}
              >
                You said
              </p>
              <p
                style={{
                  fontFamily: "'Newsreader',serif",
                  fontSize: 16,
                  color: "#5C5345",
                  margin: 0,
                  fontStyle: response.trim() ? "normal" : "italic",
                }}
              >
                {response.trim() || "(ran out of time — left blank)"}
              </p>
            </div>

            {(() => {
              const inSub = stack.length > 0;
              const correct = !graderError && result.verdict === "nailed it";
              const canBranch = correct && !inSub && !!result.nextBranch.trim();
              const canReturn = correct && inSub;
              const notQuite = !graderError && result.verdict === "not quite";
              const onTrack = !graderError && result.verdict === "on the right track";
              const imperfect = notQuite || onTrack;
              const original = inSub ? stack[stack.length - 1].title : "";

              const primaryStyle = {
                padding: "14px 26px",
                borderRadius: 14,
                fontSize: 15,
                fontWeight: 700,
                background: "#E4572E",
                color: "#fff",
                boxShadow: "0 8px 22px rgba(228,87,46,.35)",
              };
              const subtleStyle = {
                padding: "14px 22px",
                borderRadius: 14,
                fontSize: 15,
                fontWeight: 600,
                background: "#FFFDF8",
                color: "#5C5345",
                boxShadow: "inset 0 0 0 1.5px #D8CBB2",
              };

              return (
                <>
                  {canBranch && (
                    <div
                      style={{
                        marginTop: 22,
                        background: "#EDF5E6",
                        border: "1px solid #A9CC8E",
                        borderRadius: 16,
                        padding: "18px 22px",
                      }}
                    >
                      <p
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          color: "#6A994E",
                          textTransform: "uppercase",
                          letterSpacing: ".08em",
                          margin: "0 0 8px",
                        }}
                      >
                        Branch onward
                      </p>
                      <p
                        style={{
                          fontFamily: "'Fraunces', serif",
                          fontSize: 20,
                          lineHeight: 1.4,
                          color: "#2B241B",
                          margin: 0,
                        }}
                      >
                        {result.nextBranch}
                      </p>
                    </div>
                  )}

                  {canReturn && (
                    <p style={{ marginTop: 20, color: "#7A6F5E", fontSize: 15, lineHeight: 1.5 }}>
                      Sub-question solved — back to <strong>{original}</strong> to take
                      another crack at it.
                    </p>
                  )}

                  {imperfect && (
                    <p style={{ marginTop: 20, color: "#7A6F5E", fontSize: 15, lineHeight: 1.5 }}>
                      {notQuite
                        ? "Let's take another run at it — a deeper explanation that walks through the reasoning, or dig into a sub-question first."
                        : "So close — get a fuller explanation to lock it in, take another go, or dig into a sub-question first."}
                    </p>
                  )}

                  <div
                    style={{ display: "flex", gap: 12, marginTop: 22, flexWrap: "wrap" }}
                  >
                    {canBranch ? (
                      <button className="rcb-btn" onClick={continueBranch} style={primaryStyle}>
                        Continue → {result.nextBranch}
                      </button>
                    ) : canReturn ? (
                      <button className="rcb-btn" onClick={returnToOriginal} style={primaryStyle}>
                        ← Back to {original}
                      </button>
                    ) : notQuite ? (
                      <button
                        className="rcb-btn"
                        onClick={() => reexplain("deep")}
                        style={primaryStyle}
                      >
                        Explain it again, in more depth →
                      </button>
                    ) : onTrack ? (
                      <button
                        className="rcb-btn"
                        onClick={() => reexplain("light")}
                        style={primaryStyle}
                      >
                        Explain it more fully →
                      </button>
                    ) : (
                      <button
                        className="rcb-btn"
                        onClick={() => startQuestion(true)}
                        style={primaryStyle}
                      >
                        Give it another go
                      </button>
                    )}

                    {imperfect && (
                      <>
                        <button
                          className="rcb-btn"
                          onClick={() => startQuestion(true)}
                          style={subtleStyle}
                        >
                          Give it another go
                        </button>
                        <button
                          className="rcb-btn"
                          onClick={() => {
                            if (!askingSub) {
                              // Seed the sub-question's independent dials from
                              // the current lesson's, then let them diverge.
                              setSubTech(tech);
                              setSubScope(scope);
                              setSubSize(size);
                              setSubText("");
                            }
                            setAskingSub((v) => !v);
                          }}
                          style={subtleStyle}
                        >
                          Ask a sub-question
                        </button>
                      </>
                    )}

                    <button className="rcb-btn" onClick={startReflect} style={subtleStyle}>
                      Wrap up
                    </button>
                  </div>

                  {askingSub && imperfect && (
                    <div style={{ marginTop: 16 }}>
                      <p style={{ fontSize: 13, color: "#7A6F5E", margin: "0 0 8px" }}>
                        What smaller thing do you want to nail first? You&apos;ll come
                        right back here after.
                      </p>
                      <AnswerField
                        value={subText}
                        setValue={setSubText}
                        rows={2}
                        placeholder="e.g. what exactly is an event horizon?"
                      />
                      {sliderControl(
                        "How technical?",
                        subTech,
                        setSubTech,
                        technicalityLabel(subTech),
                        "Plain & everyday",
                        "Research-level"
                      )}
                      {sliderControl(
                        "Scope",
                        subScope,
                        setSubScope,
                        scopeLabel(subScope),
                        "Just the question",
                        "Wider context"
                      )}
                      {sliderControl(
                        "Response size",
                        subSize,
                        setSubSize,
                        sizeLabel(subSize),
                        "Brief",
                        "In depth"
                      )}
                      <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
                        <button
                          className="rcb-btn"
                          onClick={askSubQuestion}
                          disabled={!subText.trim()}
                          style={primaryStyle}
                        >
                          Dig into it →
                        </button>
                        <button
                          className="rcb-btn"
                          onClick={() => {
                            setAskingSub(false);
                            setSubText("");
                          }}
                          style={subtleStyle}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* ----------------------------- REFLECT ----------------------------- */}
        {phase === "reflect" && (
          <div style={{ animation: "rcb-fadeup .4s both" }}>
            {tidied === null ? (
              <>
                <p
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "#9A8F7C",
                    textTransform: "uppercase",
                    letterSpacing: ".1em",
                    margin: "0 0 10px",
                  }}
                >
                  A moment to wonder
                </p>
                <h2
                  style={{
                    fontFamily: "'Fraunces', serif",
                    fontWeight: 600,
                    fontSize: 26,
                    margin: "0 0 16px",
                    lineHeight: 1.3,
                  }}
                >
                  What do you want to look into next?
                </h2>
                <p style={{ margin: "0 0 20px", color: "#7A6F5E", fontSize: 15, lineHeight: 1.5 }}>
                  Dump whatever&apos;s rattling around — half-formed is fine. We&apos;ll
                  tidy it into questions, and suggest a couple based on how you answered —
                  then you pick which to save.
                </p>
                {tidying ? (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "22px 0",
                      color: "#5C5345",
                      fontFamily: "'Fraunces',serif",
                      fontSize: 18,
                    }}
                  >
                    <span className="rcb-spinner" /> Tidying your notes…
                  </div>
                ) : (
                  <>
                    <AnswerField
                      value={reflectInput}
                      setValue={setReflectInput}
                      rows={5}
                      placeholder="e.g. how does this connect to entropy… and what was that thing about event horizons…"
                    />
                    <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
                      <button
                        className="rcb-btn"
                        onClick={submitReflect}
                        disabled={!reflectInput.trim() && suggested.length === 0 && !suggesting}
                        style={{
                          padding: "14px 26px",
                          borderRadius: 14,
                          fontSize: 15,
                          fontWeight: 700,
                          background: "#211B14",
                          color: "#F7F1E5",
                          boxShadow: "0 8px 22px rgba(33,27,20,.3)",
                        }}
                      >
                        {reflectInput.trim() ? "Tidy into questions →" : "Review suggestions →"}
                      </button>
                      <button
                        className="rcb-btn"
                        onClick={finishToInput}
                        style={{
                          padding: "14px 22px",
                          borderRadius: 14,
                          fontSize: 15,
                          fontWeight: 600,
                          background: "#FFFDF8",
                          color: "#5C5345",
                          boxShadow: "inset 0 0 0 1.5px #D8CBB2",
                        }}
                      >
                        Skip
                      </button>
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                <p
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "#9A8F7C",
                    textTransform: "uppercase",
                    letterSpacing: ".1em",
                    margin: "0 0 6px",
                  }}
                >
                  {suggested.length || (tidied && tidied.length)
                    ? "Tap to choose what to save"
                    : "Nothing to save"}
                </p>
                {(suggested.length > 0 || (tidied && tidied.length > 0)) && (
                  <p style={{ margin: "0 0 18px", color: "#7A6F5E", fontSize: 14 }}>
                    Nothing is added unless you pick it.
                  </p>
                )}

                {(suggesting || suggested.length > 0) && (
                  <div style={{ marginBottom: 20 }}>
                    <p
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: "#6A994E",
                        textTransform: "uppercase",
                        letterSpacing: ".08em",
                        margin: "0 0 10px",
                      }}
                    >
                      Suggested from your answers
                    </p>
                    {suggesting ? (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          color: "#5C5345",
                          fontFamily: "'Fraunces',serif",
                          fontSize: 16,
                        }}
                      >
                        <span className="rcb-spinner" /> Reading how you answered…
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        {suggested.map((s, idx) =>
                          pickRow(`s${idx}`, s, pickS.has(idx), () => toggleSuggested(idx), "#6A994E")
                        )}
                      </div>
                    )}
                  </div>
                )}

                {tidied && tidied.length > 0 && (
                  <div style={{ marginBottom: 20 }}>
                    <p
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: "#9A8F7C",
                        textTransform: "uppercase",
                        letterSpacing: ".08em",
                        margin: "0 0 10px",
                      }}
                    >
                      From your notes
                    </p>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {tidied.map((q, idx) =>
                        pickRow(`t${idx}`, q, pickT.has(idx), () => toggleTidied(idx), "#E4572E")
                      )}
                    </div>
                  </div>
                )}

                {!suggesting &&
                  suggested.length === 0 &&
                  (!tidied || tidied.length === 0) && (
                    <p style={{ color: "#7A6F5E", fontSize: 16, margin: "0 0 18px" }}>
                      {reflectInput.trim()
                        ? "Couldn't pull a clear question out of your notes — no worries."
                        : "Nothing to save — no worries."}
                    </p>
                  )}

                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <button
                    className="rcb-btn"
                    onClick={saveReflect}
                    style={{
                      padding: "14px 26px",
                      borderRadius: 14,
                      fontSize: 15,
                      fontWeight: 700,
                      background: "#E4572E",
                      color: "#fff",
                      boxShadow: "0 8px 22px rgba(228,87,46,.35)",
                    }}
                  >
                    {selectedCount > 0 ? `Add ${selectedCount} to my list →` : "Done →"}
                  </button>
                  {selectedCount > 0 && (
                    <button
                      className="rcb-btn"
                      onClick={finishToInput}
                      style={{
                        padding: "14px 22px",
                        borderRadius: 14,
                        fontSize: 15,
                        fontWeight: 600,
                        background: "#FFFDF8",
                        color: "#5C5345",
                        boxShadow: "inset 0 0 0 1.5px #D8CBB2",
                      }}
                    >
                      Discard
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
