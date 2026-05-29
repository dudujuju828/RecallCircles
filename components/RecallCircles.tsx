"use client";

import { useEffect, useRef, useState } from "react";
import {
  ANSWER_SECONDS,
  COLORS,
  READ_SECONDS,
  TECH_DEFAULT,
  TECH_MAX,
  TECH_MIN,
  colorOf,
  technicalityLabel,
} from "@/lib/constants";
import { fmt } from "@/lib/utils";
import type { Phase, QueueItem, Response } from "@/lib/types";
import {
  errorMessage,
  generateExplanation,
  isAuthError,
  respondToAnswer,
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
import { useTTS } from "@/lib/useTTS";
import AnswerField from "./AnswerField";
import SettingsModal from "./SettingsModal";

const verdictColor = (v: string) =>
  v === "nailed it" ? "#6A994E" : v === "not quite" ? "#D85A47" : "#C7892B";

export default function RecallCircles() {
  const [phase, setPhase] = useState<Phase>("input");
  const [topic, setTopic] = useState("");
  const [tech, setTech] = useState(TECH_DEFAULT);

  const [title, setTitle] = useState("");
  const [explanation, setExplanation] = useState("");
  const [question, setQuestion] = useState("");
  const [keyPoints, setKeyPoints] = useState<string[]>([]);
  // Breadcrumb of titles covered this session, so branches read as a chain.
  const [trail, setTrail] = useState<string[]>([]);

  const [response, setResponse] = useState("");
  const [timeLeft, setTimeLeft] = useState(ANSWER_SECONDS);
  const [readLeft, setReadLeft] = useState(READ_SECONDS);
  const [result, setResult] = useState<Response | null>(null);
  const [graderError, setGraderError] = useState(false);
  const [error, setError] = useState("");

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

  /* ------------------------ explain (generate lesson) --------------------- */
  async function runGenerate(
    targetTopic: string,
    fromTopic: string | null,
    resetTrail: boolean
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
      const lesson = await generateExplanation(apiKey, t, tech, fromTopic);
      setTitle(lesson.title);
      setExplanation(lesson.explanation);
      setQuestion(lesson.question);
      setKeyPoints(lesson.keyPoints);
      setResult(null);
      setTrail((prev) => (resetTrail ? [lesson.title] : [...prev, lesson.title]));
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
    runGenerate(topic, null, true);
  }

  function continueBranch() {
    const nb = result?.nextBranch?.trim();
    if (!nb) return;
    setTopic(nb);
    runGenerate(nb, title, false);
  }

  /* ----------------------------- timed question ---------------------------- */
  // Used both for the first question after the explanation and for "give it
  // another go" — both reset to a fresh ANSWER_SECONDS clock.
  function startQuestion() {
    tts.stop(); // the explanation gets hidden now — don't keep narrating it
    setResponse("");
    setResult(null);
    submittedRef.current = false;
    setTimeLeft(ANSWER_SECONDS);
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
    try {
      const r = await respondToAnswer(apiKey, {
        explanation,
        question,
        keyPoints,
        answer: text || "",
      });
      setResult(r);
      spoken = r.feedback;
    } catch (e) {
      if (isAuthError(e)) {
        setAuthError("That key was rejected — check it and try again.");
        setShowSettings(true);
      }
      // Couldn't verify — don't trap the user; let them retry or wrap up.
      setGraderError(true);
      const fallback =
        "Couldn't reach the grader just now — the key idea: " +
        (keyPoints.join("; ") || title) +
        ".";
      setResult({
        verdict: "on the right track",
        feedback: fallback,
        nextBranch: "",
      });
      spoken = fallback;
    }
    setPhase("respond");
    if (tts.enabled) tts.speak(spoken);
  }

  /* ------------------------------- reflect ------------------------------- */
  function startReflect() {
    tts.stop();
    setReflectInput("");
    setTidied(null);
    setTidying(false);
    setPhase("reflect");
  }

  function finishToInput() {
    tts.stop();
    setReflectInput("");
    setTidied(null);
    setTidying(false);
    setTopic("");
    setTrail([]);
    setResult(null);
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

            {/* technicality slider */}
            <div style={{ marginTop: 24 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  marginBottom: 10,
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
                  How technical?
                </label>
                <span style={{ fontSize: 14, color: "#5C5345", fontWeight: 600 }}>
                  {technicalityLabel(tech)}{" "}
                  <span style={{ opacity: 0.6 }}>· {tech}/10</span>
                </span>
              </div>
              <input
                type="range"
                min={TECH_MIN}
                max={TECH_MAX}
                step={1}
                value={tech}
                onChange={(e) => setTech(Number(e.target.value))}
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
                <span>Plain &amp; everyday</span>
                <span>Research-level</span>
              </div>
            </div>

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
                {timeLeft}s
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
                  width: `${(timeLeft / ANSWER_SECONDS) * 100}%`,
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
              const correct = !graderError && result.verdict === "nailed it";
              const canBranch = correct && !!result.nextBranch.trim();
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

                  <div
                    style={{ display: "flex", gap: 12, marginTop: 22, flexWrap: "wrap" }}
                  >
                    {canBranch ? (
                      <button
                        className="rcb-btn"
                        onClick={continueBranch}
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
                        Continue → {result.nextBranch}
                      </button>
                    ) : (
                      <button
                        className="rcb-btn"
                        onClick={startQuestion}
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
                        Give it another go
                      </button>
                    )}
                    <button
                      className="rcb-btn"
                      onClick={startReflect}
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
                      Wrap up
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
