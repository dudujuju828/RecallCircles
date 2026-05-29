"use client";

import { Dispatch, SetStateAction } from "react";
import { useSpeechRecognition } from "@/lib/useSpeechRecognition";

function MicIcon({ color }: { color: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" fill={color} />
      <path
        d="M5 11a7 7 0 0 0 14 0"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      <line x1="12" y1="18" x2="12" y2="22" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Textarea with optional voice input. Finalized speech is committed to the
 * parent's value; interim speech is shown appended live. Typing works
 * alongside. Where the Web Speech API is unavailable (or mic is blocked) the
 * mic hides and only the textarea remains.
 */
export default function AnswerField({
  value,
  setValue,
  placeholder,
  autoFocus,
  rows = 4,
}: {
  value: string;
  setValue: Dispatch<SetStateAction<string>>;
  placeholder: string;
  autoFocus?: boolean;
  rows?: number;
}) {
  const { supported, listening, interim, error, start, stop } =
    useSpeechRecognition({
      onFinal: (text) =>
        setValue((prev) => {
          const base = prev.replace(/\s+$/, "");
          return base ? `${base} ${text}` : text;
        }),
    });

  const sep = value && !/\s$/.test(value) ? " " : "";
  const display = interim ? value + sep + interim : value;

  return (
    <div style={{ position: "relative" }}>
      <textarea
        className="rcb-ta"
        rows={rows}
        autoFocus={autoFocus}
        value={display}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        style={{ paddingRight: supported ? 60 : 18 }}
      />
      {supported && (
        <button
          type="button"
          className="rcb-btn"
          aria-label={listening ? "Stop voice input" : "Start voice input"}
          onClick={() => (listening ? stop() : start())}
          style={{
            position: "absolute",
            right: 12,
            bottom: 14,
            width: 42,
            height: 42,
            borderRadius: "50%",
            background: listening ? "#D81E5B" : "#FFFDF8",
            boxShadow: listening
              ? "0 0 0 5px rgba(216,30,91,.18)"
              : "inset 0 0 0 1.5px #D8CBB2",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            animation: listening ? "rcb-pulse 1s infinite" : "none",
          }}
        >
          <MicIcon color={listening ? "#fff" : "#7A6F5E"} />
        </button>
      )}
      {supported && listening && (
        <p style={{ fontSize: 12, color: "#D81E5B", margin: "8px 2px 0", fontWeight: 600 }}>
          Listening… speak your answer.
        </p>
      )}
      {!supported && (
        <p style={{ fontSize: 12, color: "#9A8F7C", margin: "8px 2px 0" }}>
          Voice input isn&apos;t supported in this browser — typing works fine.
        </p>
      )}
      {error && (
        <p style={{ fontSize: 12, color: "#C0392B", margin: "8px 2px 0" }}>{error}</p>
      )}
    </div>
  );
}
