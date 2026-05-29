"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ANSWER_SECONDS,
  COLORS,
  HINT_BUDGET,
  LEVELS,
  READ_SECONDS,
  colorOf,
} from "@/lib/constants";
import { firstWords, fmt, shuffle } from "@/lib/utils";
import type {
  Grade,
  Level,
  Phase,
  Piece,
  QueueItem,
} from "@/lib/types";
import {
  errorMessage,
  generatePassage,
  gradeAnswer,
  isAuthError,
  splitThoughts,
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
import AnswerField from "./AnswerField";
import SettingsModal from "./SettingsModal";

const verdictColor = (v: string) =>
  v === "nailed it" ? "#6A994E" : v === "not quite" ? "#D85A47" : "#C7892B";

/** Compact seconds label: "30s" under a minute, "1:00" at/above. */
const labelSecs = (s: number) => (s >= 60 ? fmt(s) : `${s}s`);

export default function RecallCircles() {
  const [phase, setPhase] = useState<Phase>("input");
  const [topic, setTopic] = useState("");
  const [level, setLevel] = useState<Level>("standard");

  const [title, setTitle] = useState("");
  const [chunks, setChunks] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [keyPoints, setKeyPoints] = useState<string[]>([]);

  const [pool, setPool] = useState<Piece[]>([]);
  const [answer, setAnswer] = useState<number[]>([]);
  const [graded, setGraded] = useState<boolean[] | null>(null);
  const [hintedSlots, setHintedSlots] = useState<Record<number, string>>({});
  const [hintsUsed, setHintsUsed] = useState(0);
  const [showOriginal, setShowOriginal] = useState(false);

  const [response, setResponse] = useState("");
  const [timeLeft, setTimeLeft] = useState(ANSWER_SECONDS);
  const [readLeft, setReadLeft] = useState(READ_SECONDS);
  const [feedback, setFeedback] = useState<Grade | null>(null);
  const [error, setError] = useState("");

  // Answer rounds: the question repeats until "nailed it", doubling the clock
  // each time (30s → 60s → 2:00 → …). `roundSeconds` is the current round's
  // total (timer denominator); `graderError` lets us avoid trapping the user
  // in a retry loop when the grader couldn't be reached.
  const [attempt, setAttempt] = useState(1);
  const [roundSeconds, setRoundSeconds] = useState(ANSWER_SECONDS);
  const [graderError, setGraderError] = useState(false);

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

  const N = chunks.length;
  const textOf = (id: number) => chunks[id];

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

  /* ------------------ generate passage + question + key points ------------- */
  async function generate() {
    const t = topic.trim();
    if (!t) return;
    if (!apiKey.trim()) {
      setError("Add your Anthropic key to begin.");
      setShowSettings(true);
      return;
    }
    setPhase("loading");
    setError("");
    try {
      const p = await generatePassage(apiKey, t, level);
      setTitle(p.title);
      setChunks(p.chunks);
      setQuestion(p.question);
      setKeyPoints(p.keyPoints);
      setShowOriginal(false);
      // A queued curiosity has now become a round — retire it.
      if (pendingQueueId) {
        removeFromQueue(pendingQueueId);
        setPendingQueueId(null);
      }
      setPhase("read");
    } catch (e) {
      setError(errorMessage(e));
      if (isAuthError(e)) {
        setAuthError("That key was rejected — check it and try again.");
        setShowSettings(true);
      }
      setPhase("input");
    }
  }

  /* ----------------------------- reconstruction ---------------------------- */
  function startBuild() {
    setPool(shuffle(chunks.map((_, i) => ({ id: i, revealed: false }))));
    setAnswer([]);
    setGraded(null);
    setHintedSlots({});
    setHintsUsed(0);
    setShowOriginal(false);
    setPhase("build");
  }

  function tapCircle(id: number) {
    const item = pool.find((p) => p.id === id);
    if (!item) return;
    if (!item.revealed) {
      setPool((p) => p.map((x) => (x.id === id ? { ...x, revealed: true } : x)));
    } else {
      setPool((p) => p.filter((x) => x.id !== id));
      setAnswer((a) => [...a, id]);
    }
  }

  function removeFromAnswer(id: number) {
    if (graded) return;
    setAnswer((a) => a.filter((x) => x !== id));
    setPool((p) => [...p, { id, revealed: true }]);
  }

  function useHint() {
    const slot = answer.length;
    if (hintsUsed >= HINT_BUDGET || slot >= N || hintedSlots[slot]) return;
    setHintedSlots((h) => ({ ...h, [slot]: firstWords(chunks[slot]) }));
    setHintsUsed((c) => c + 1);
  }

  function check() {
    setGraded(answer.map((id, idx) => id === idx));
    setPhase("result");
  }

  /* ----------------------------- timed question ---------------------------- */
  function startQuestion() {
    setAttempt(1);
    setRoundSeconds(ANSWER_SECONDS);
    setTimeLeft(ANSWER_SECONDS);
    setResponse("");
    setFeedback(null);
    submittedRef.current = false;
    setPhase("question");
  }

  // Another go at the same question after a not-quite answer. Each round
  // doubles the clock: round 1 = 30s, round 2 = 60s, round 3 = 2:00, …
  function retryQuestion() {
    const nextAttempt = attempt + 1;
    const secs = ANSWER_SECONDS * 2 ** (nextAttempt - 1);
    setAttempt(nextAttempt);
    setRoundSeconds(secs);
    setTimeLeft(secs);
    setResponse("");
    setFeedback(null);
    submittedRef.current = false;
    setPhase("question");
  }

  // READ countdown — auto-advances to build at 0.
  useEffect(() => {
    if (phase !== "read") return;
    readSettledRef.current = false;
    setReadLeft(READ_SECONDS);
    const iv = setInterval(() => {
      setReadLeft((t) => {
        if (t <= 1) {
          clearInterval(iv);
          if (!readSettledRef.current) {
            readSettledRef.current = true;
            startBuild();
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
    try {
      const g = await gradeAnswer(apiKey, {
        chunks,
        question,
        keyPoints,
        answer: text || "",
      });
      setFeedback(g);
    } catch (e) {
      if (isAuthError(e)) {
        setAuthError("That key was rejected — check it and try again.");
        setShowSettings(true);
      }
      // Couldn't verify correctness — don't trap the user in retries.
      setGraderError(true);
      setFeedback({
        verdict: "on the right track",
        feedback:
          "Couldn't reach the grader just now — the key idea: " +
          (keyPoints.join("; ") || title) +
          ".",
        modelAnswer: keyPoints.join(" ") || title,
      });
    }
    setPhase("feedback");
  }

  /* ------------------------------- reflect ------------------------------- */
  function startReflect() {
    setReflectInput("");
    setTidied(null);
    setTidying(false);
    setPhase("reflect");
  }

  function finishToInput() {
    setReflectInput("");
    setTidied(null);
    setTidying(false);
    setTopic("");
    setPendingQueueId(null);
    setError("");
    setPhase("input");
  }

  async function submitReflect() {
    const dump = reflectInput.trim();
    if (!dump) {
      finishToInput();
      return;
    }
    if (!apiKey.trim()) {
      // No key to tidy with — keep the raw lines so nothing is lost.
      setTidied(dump.split(/\n+/).map((s) => s.trim()).filter(Boolean));
      return;
    }
    setTidying(true);
    try {
      const qs = await splitThoughts(apiKey, dump, title || topic);
      setTidied(qs);
    } catch {
      // Fall back to the raw lines rather than dropping the user's notes.
      setTidied(dump.split(/\n+/).map((s) => s.trim()).filter(Boolean));
    }
    setTidying(false);
  }

  function removeTidied(idx: number) {
    setTidied((qs) => (qs ? qs.filter((_, i) => i !== idx) : qs));
  }

  function saveTidied() {
    if (tidied && tidied.length) {
      const additions: QueueItem[] = tidied.map((text) => ({
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

  const correctCount = graded ? graded.filter(Boolean).length : 0;
  const maskedHeaderKey = savedKey
    ? maskKey(savedKey)
    : apiKey
      ? "this session"
      : null;

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
        <p style={{ margin: "0 0 28px", color: "#7A6F5E", fontSize: 15 }}>
          Read once. Rebuild from memory. Then explain it back.
        </p>

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
                // Editing breaks the link to a tapped queue chip.
                if (pendingQueueId) setPendingQueueId(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && generate()}
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
            <div style={{ display: "flex", gap: 10, marginTop: 18, flexWrap: "wrap" }}>
              {(Object.entries(LEVELS) as [Level, (typeof LEVELS)[Level]][]).map(
                ([key, v]) => {
                  const on = level === key;
                  return (
                    <button
                      key={key}
                      className="rcb-btn"
                      onClick={() => setLevel(key)}
                      style={{
                        padding: "10px 18px",
                        borderRadius: 999,
                        fontSize: 14,
                        fontWeight: 600,
                        background: on ? "#211B14" : "#FFFDF8",
                        color: on ? "#F7F1E5" : "#5C5345",
                        boxShadow: on
                          ? "0 4px 14px rgba(33,27,20,.22)"
                          : "inset 0 0 0 1.5px #D8CBB2",
                      }}
                    >
                      {v.label}
                      <span style={{ opacity: 0.6, marginLeft: 8, fontWeight: 500 }}>
                        {v.n} pieces
                      </span>
                    </button>
                  );
                }
              )}
            </div>
            {error && (
              <p style={{ color: "#C0392B", fontSize: 14, marginTop: 16 }}>{error}</p>
            )}
            <button
              className="rcb-btn"
              onClick={generate}
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
              Generate passage →
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
              {phase === "loading" ? "Writing your passage…" : "Reading your answer…"}
            </p>
          </div>
        )}

        {/* ----------------------------- READ ----------------------------- */}
        {phase === "read" && (
          <div style={{ animation: "rcb-fadeup .45s both" }}>
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
                Learn it — scrambles when time&apos;s up
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
              {chunks.join(" ")}
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
                    startBuild();
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
                I&apos;m ready — scramble it ↯
              </button>
              <span style={{ fontSize: 14, color: "#9A8F7C" }}>
                Tap when you&apos;ve got it, or let the clock decide.
              </span>
            </div>
          </div>
        )}

        {/* ----------------------------- BUILD / RESULT ----------------------------- */}
        {(phase === "build" || phase === "result") && (
          <div style={{ animation: "rcb-fadeup .4s both" }}>
            {pool.length > 0 && (
              <>
                <p
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "#9A8F7C",
                    textTransform: "uppercase",
                    letterSpacing: ".1em",
                    margin: "0 0 12px",
                  }}
                >
                  The pieces — tap to reveal, tap again to place
                </p>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 14,
                    marginBottom: 30,
                  }}
                >
                  <AnimatePresence mode="popLayout">
                    {pool.map((p) =>
                      p.revealed ? (
                        <motion.div
                          key={p.id}
                          layout
                          layoutId={`piece-${p.id}`}
                          initial={{ opacity: 0, scale: 0.85 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.85 }}
                          transition={{ type: "spring", stiffness: 500, damping: 38 }}
                          className="rcb-pill"
                          onClick={() => tapCircle(p.id)}
                          style={{
                            flex: "1 1 240px",
                            maxWidth: "100%",
                            fontFamily: "'Newsreader', serif",
                            fontSize: 16,
                            lineHeight: 1.4,
                            padding: "14px 16px 14px 18px",
                            borderRadius: 14,
                            background: "#FFFDF8",
                            borderLeft: `6px solid ${colorOf(p.id)}`,
                            boxShadow: "0 6px 18px -10px rgba(80,60,30,.4)",
                          }}
                        >
                          {textOf(p.id)}
                          <span
                            style={{
                              display: "block",
                              marginTop: 6,
                              fontFamily: "'Hanken Grotesk',sans-serif",
                              fontSize: 12,
                              fontWeight: 600,
                              color: colorOf(p.id),
                            }}
                          >
                            tap to place ↓
                          </span>
                        </motion.div>
                      ) : (
                        <motion.div
                          key={p.id}
                          layout
                          layoutId={`piece-${p.id}`}
                          initial={{ opacity: 0, y: 14 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.8 }}
                          transition={{ type: "spring", stiffness: 420, damping: 30 }}
                          className="rcb-dot"
                          onClick={() => tapCircle(p.id)}
                          style={{
                            width: 66,
                            height: 66,
                            borderRadius: "50%",
                            background: colorOf(p.id),
                            boxShadow: `0 8px 18px -6px ${colorOf(p.id)}`,
                          }}
                        />
                      )
                    )}
                  </AnimatePresence>
                </div>
              </>
            )}

            <p
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "#9A8F7C",
                textTransform: "uppercase",
                letterSpacing: ".1em",
                margin: "0 0 12px",
              }}
            >
              Your paragraph
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {Array.from({ length: N }).map((_, slot) => {
                const id = answer[slot];
                const filled = id !== undefined;
                const ok = graded ? graded[slot] : null;
                const hint = hintedSlots[slot];
                return (
                  <motion.div
                    key={slot}
                    layout
                    transition={{ type: "spring", stiffness: 500, damping: 40 }}
                    onClick={() => filled && removeFromAnswer(id)}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 14,
                      padding: "14px 16px",
                      borderRadius: 14,
                      minHeight: 56,
                      cursor: filled && !graded ? "pointer" : "default",
                      background: filled ? "#FFFDF8" : "transparent",
                      border: filled
                        ? `1.5px solid ${
                            ok === null ? "#E4D8C0" : ok ? "#6A994E" : "#D85A47"
                          }`
                        : "1.5px dashed #D2C4A8",
                    }}
                  >
                    <span
                      style={{
                        flexShrink: 0,
                        width: 26,
                        height: 26,
                        borderRadius: "50%",
                        background: filled ? colorOf(id) : "#E7DCC6",
                        color: "#fff",
                        fontSize: 13,
                        fontWeight: 700,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      {slot + 1}
                    </span>
                    {filled ? (
                      <motion.span
                        layoutId={`piece-${id}`}
                        style={{
                          fontFamily: "'Newsreader', serif",
                          fontSize: 17,
                          lineHeight: 1.4,
                          color: "#2B241B",
                          paddingTop: 1,
                        }}
                      >
                        {textOf(id)}
                        {graded && ok === false && (
                          <span
                            style={{
                              display: "block",
                              marginTop: 4,
                              fontFamily: "'Hanken Grotesk',sans-serif",
                              fontSize: 12,
                              fontWeight: 700,
                              color: "#D85A47",
                            }}
                          >
                            out of place
                          </span>
                        )}
                      </motion.span>
                    ) : (
                      <span
                        style={{
                          fontFamily: "'Newsreader', serif",
                          fontSize: 17,
                          lineHeight: 1.4,
                          color: "#B6A98E",
                          paddingTop: 1,
                        }}
                      >
                        {hint ? (
                          <span style={{ fontStyle: "italic" }}>
                            starts with “{hint}”
                          </span>
                        ) : (
                          "empty"
                        )}
                      </span>
                    )}
                  </motion.div>
                );
              })}
            </div>

            {phase === "build" && (
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  marginTop: 24,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <button
                  className="rcb-btn"
                  onClick={check}
                  disabled={answer.length !== N}
                  style={{
                    padding: "15px 30px",
                    borderRadius: 14,
                    fontSize: 16,
                    fontWeight: 700,
                    background: "#E4572E",
                    color: "#fff",
                    boxShadow: "0 8px 22px rgba(228,87,46,.35)",
                  }}
                >
                  Check my order
                </button>
                <button
                  className="rcb-btn"
                  onClick={useHint}
                  disabled={hintsUsed >= HINT_BUDGET || answer.length >= N}
                  style={{
                    padding: "13px 22px",
                    borderRadius: 14,
                    fontSize: 14,
                    fontWeight: 600,
                    background: "#FFFDF8",
                    color: "#5C5345",
                    boxShadow: "inset 0 0 0 1.5px #D8CBB2",
                  }}
                >
                  💡 Hint <span style={{ opacity: 0.6 }}>({HINT_BUDGET - hintsUsed} left)</span>
                </button>
              </div>
            )}

            {phase === "result" && (
              <div style={{ marginTop: 26, animation: "rcb-fadeup .4s both" }}>
                <div
                  style={{
                    padding: "20px 24px",
                    borderRadius: 18,
                    background: correctCount === N ? "#EDF5E6" : "#FBF1E8",
                    border: `1.5px solid ${correctCount === N ? "#A9CC8E" : "#EBC9A8"}`,
                  }}
                >
                  <p
                    style={{
                      fontFamily: "'Fraunces', serif",
                      fontWeight: 600,
                      fontSize: 22,
                      margin: 0,
                    }}
                  >
                    {correctCount === N
                      ? "Rebuilt exactly."
                      : `${correctCount} of ${N} in the right place.`}
                  </p>
                  <p style={{ margin: "6px 0 0", color: "#7A6F5E", fontSize: 14 }}>
                    {correctCount === N
                      ? hintsUsed === 0
                        ? "From memory, no hints — that's the whole thing back."
                        : `Nicely done — with ${hintsUsed} hint${hintsUsed > 1 ? "s" : ""}.`
                      : "Red slots drifted. Now put the idea in your own words ↓"}
                  </p>
                </div>
                <button
                  className="rcb-btn"
                  onClick={startQuestion}
                  style={{
                    marginTop: 18,
                    padding: "15px 30px",
                    borderRadius: 14,
                    fontSize: 16,
                    fontWeight: 700,
                    background: "#211B14",
                    color: "#F7F1E5",
                    boxShadow: "0 8px 22px rgba(33,27,20,.3)",
                  }}
                >
                  Next: one question →
                </button>
                <div style={{ display: "flex", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
                  <button
                    className="rcb-btn"
                    onClick={() => setShowOriginal((s) => !s)}
                    style={{
                      padding: "11px 18px",
                      borderRadius: 12,
                      fontSize: 14,
                      fontWeight: 600,
                      background: "#FFFDF8",
                      color: "#5C5345",
                      boxShadow: "inset 0 0 0 1.5px #D8CBB2",
                    }}
                  >
                    {showOriginal ? "Hide original" : "See the original"}
                  </button>
                  <button
                    className="rcb-btn"
                    onClick={startBuild}
                    style={{
                      padding: "11px 18px",
                      borderRadius: 12,
                      fontSize: 14,
                      fontWeight: 600,
                      background: "#FFFDF8",
                      color: "#5C5345",
                      boxShadow: "inset 0 0 0 1.5px #D8CBB2",
                    }}
                  >
                    Shuffle & retry
                  </button>
                </div>
                {showOriginal && (
                  <div
                    style={{
                      marginTop: 16,
                      fontFamily: "'Newsreader', serif",
                      fontSize: 18,
                      lineHeight: 1.6,
                      color: "#2B241B",
                      background: "#FFFDF8",
                      border: "1px solid #E4D8C0",
                      borderRadius: 16,
                      padding: "22px 24px",
                    }}
                  >
                    {chunks.join(" ")}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ----------------------------- QUESTION (timed) ----------------------------- */}
        {phase === "question" && (
          <div style={{ animation: "rcb-fadeup .4s both" }}>
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
                In your own words{attempt > 1 ? ` · round ${attempt}` : ""}
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
                {labelSecs(timeLeft)}
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
                  width: `${(timeLeft / roundSeconds) * 100}%`,
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

        {/* ----------------------------- FEEDBACK ----------------------------- */}
        {phase === "feedback" && feedback && (
          <div style={{ animation: "rcb-fadeup .4s both" }}>
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
                background: verdictColor(feedback.verdict),
              }}
            >
              {feedback.verdict}
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
              {feedback.feedback}
            </p>

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
              const nailed = feedback.verdict === "nailed it";
              // Only a correct answer opens the road to "what next". If the
              // grader was unreachable we can't verify, so we let them through
              // rather than trap them in an unwinnable retry loop.
              const canAdvance = nailed || graderError;
              const nextRoundSecs = ANSWER_SECONDS * 2 ** attempt;
              return (
                <>
                  {!canAdvance && (
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
                        A model answer
                      </p>
                      <p
                        style={{
                          fontFamily: "'Newsreader', serif",
                          fontSize: 18,
                          lineHeight: 1.55,
                          color: "#2B241B",
                          margin: 0,
                        }}
                      >
                        {feedback.modelAnswer}
                      </p>
                      <p style={{ margin: "12px 0 0", fontSize: 14, color: "#5C5345" }}>
                        Take it in, then put the idea back in your own words —
                        you&apos;ll get {labelSecs(nextRoundSecs)} this round.
                      </p>
                    </div>
                  )}

                  <div
                    style={{ display: "flex", gap: 12, marginTop: 22, flexWrap: "wrap" }}
                  >
                    {canAdvance ? (
                      <button
                        className="rcb-btn"
                        onClick={startReflect}
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
                        What next? →
                      </button>
                    ) : (
                      <button
                        className="rcb-btn"
                        onClick={retryQuestion}
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
                        Try again — {labelSecs(nextRoundSecs)} →
                      </button>
                    )}
                    <button
                      className="rcb-btn"
                      onClick={() => setPhase("read")}
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
                      Replay this one
                    </button>
                  </div>
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
                <p style={{ margin: "0 0 16px", color: "#7A6F5E", fontSize: 15, lineHeight: 1.5 }}>
                  Dump whatever&apos;s rattling around — half-formed is fine. We&apos;ll
                  tidy it into clean questions you can study later.
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
                        disabled={!reflectInput.trim()}
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
                        Tidy into questions →
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
                    margin: "0 0 12px",
                  }}
                >
                  {tidied.length ? "Save these for later?" : "Nothing to save"}
                </p>
                {tidied.length === 0 ? (
                  <p style={{ color: "#7A6F5E", fontSize: 16, margin: "0 0 18px" }}>
                    Couldn&apos;t pull a clear question out of that — no worries.
                  </p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
                    {tidied.map((q, idx) => (
                      <div
                        key={idx}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 12,
                          padding: "14px 16px",
                          borderRadius: 14,
                          background: "#FFFDF8",
                          border: "1px solid #E4D8C0",
                        }}
                      >
                        <span
                          style={{
                            flexShrink: 0,
                            width: 24,
                            height: 24,
                            borderRadius: "50%",
                            background: colorOf(idx),
                            color: "#fff",
                            fontSize: 12,
                            fontWeight: 700,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          {idx + 1}
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
                          {q}
                        </span>
                        <button
                          className="rcb-btn"
                          aria-label="Remove"
                          onClick={() => removeTidied(idx)}
                          style={{
                            background: "transparent",
                            color: "#B6A98E",
                            fontSize: 18,
                            lineHeight: 1,
                            padding: "0 4px",
                            fontWeight: 700,
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <button
                    className="rcb-btn"
                    onClick={saveTidied}
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
                    {tidied.length ? "Save to my list →" : "Done →"}
                  </button>
                  {tidied.length > 0 && (
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
                      Skip saving
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
