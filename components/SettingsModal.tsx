"use client";

import { useEffect, useState } from "react";
import { looksLikeKey } from "@/lib/anthropic";
import { maskKey } from "@/lib/storage";

/**
 * BYOK key entry. The key is held in React state by default and only persisted
 * to localStorage when "Remember on this device" is ticked. Saved keys are
 * shown masked, and "Forget key" clears both state and storage.
 */
export default function SettingsModal({
  open,
  onClose,
  apiKey,
  remember,
  savedKey,
  authError,
  onSave,
  onForget,
}: {
  open: boolean;
  onClose: () => void;
  apiKey: string;
  remember: boolean;
  /** The key currently persisted to localStorage, if any. */
  savedKey: string | null;
  /** A 401 message to surface (e.g. after a rejected key). */
  authError: string;
  onSave: (key: string, remember: boolean) => void;
  onForget: () => void;
}) {
  const [draft, setDraft] = useState(apiKey);
  const [rememberDraft, setRememberDraft] = useState(remember);
  const [localError, setLocalError] = useState("");

  // Re-sync the draft each time the modal opens.
  useEffect(() => {
    if (open) {
      setDraft(apiKey);
      setRememberDraft(remember);
      setLocalError("");
    }
  }, [open, apiKey, remember]);

  if (!open) return null;

  const save = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setLocalError("Paste your Anthropic key to continue.");
      return;
    }
    if (!looksLikeKey(trimmed)) {
      setLocalError("That doesn't look like an Anthropic key — they start with “sk-ant-”.");
      return;
    }
    onSave(trimmed, rememberDraft);
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(33,27,20,.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        zIndex: 50,
        animation: "rcb-fadeup .25s both",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 460,
          background: "#FBF7EE",
          borderRadius: 22,
          padding: "28px 26px",
          boxShadow: "0 30px 80px -30px rgba(33,27,20,.6)",
          border: "1px solid #E4D8C0",
        }}
      >
        <h2
          style={{
            fontFamily: "'Fraunces', serif",
            fontWeight: 900,
            fontSize: 24,
            margin: "0 0 6px",
            letterSpacing: "-0.01em",
          }}
        >
          Your Anthropic key
        </h2>
        <p style={{ margin: "0 0 18px", color: "#7A6F5E", fontSize: 14, lineHeight: 1.5 }}>
          Bring your own key. It goes straight from your browser to Anthropic —
          never to our server, never logged.
        </p>

        <label
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: "#5C5345",
            textTransform: "uppercase",
            letterSpacing: ".08em",
          }}
        >
          API key
        </label>
        <input
          type="password"
          value={draft}
          autoFocus
          onChange={(e) => {
            setDraft(e.target.value);
            setLocalError("");
          }}
          onKeyDown={(e) => e.key === "Enter" && save()}
          placeholder="sk-ant-…"
          style={{
            width: "100%",
            marginTop: 8,
            padding: "13px 15px",
            fontSize: 15,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            border: "1.5px solid #D8CBB2",
            borderRadius: 12,
            background: "#FFFDF8",
            outline: "none",
            color: "#211B14",
          }}
        />

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 16,
            fontSize: 14,
            color: "#5C5345",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={rememberDraft}
            onChange={(e) => setRememberDraft(e.target.checked)}
            style={{ width: 17, height: 17, accentColor: "#E4572E" }}
          />
          Remember on this device
        </label>
        <p style={{ margin: "8px 0 0", color: "#9A8F7C", fontSize: 12, lineHeight: 1.5 }}>
          If ticked, the key is stored <strong>unencrypted</strong> in this
          browser&apos;s local storage. Leave it off to keep the key only for
          this session.
        </p>

        {(localError || authError) && (
          <p style={{ color: "#C0392B", fontSize: 13, marginTop: 14, marginBottom: 0 }}>
            {localError || authError}
          </p>
        )}

        {savedKey && (
          <div
            style={{
              marginTop: 18,
              padding: "12px 14px",
              borderRadius: 12,
              background: "#F2EADB",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <span style={{ fontSize: 13, color: "#5C5345" }}>
              Saved on this device:{" "}
              <code style={{ fontFamily: "ui-monospace, monospace" }}>
                {maskKey(savedKey)}
              </code>
            </span>
            <button
              className="rcb-btn"
              onClick={onForget}
              style={{
                padding: "7px 14px",
                borderRadius: 999,
                fontSize: 13,
                fontWeight: 600,
                background: "#FFFDF8",
                color: "#C0392B",
                boxShadow: "inset 0 0 0 1.5px #E3B4A8",
              }}
            >
              Forget key
            </button>
          </div>
        )}

        <div style={{ display: "flex", gap: 12, marginTop: 22, justifyContent: "flex-end" }}>
          <button
            className="rcb-btn"
            onClick={onClose}
            style={{
              padding: "12px 20px",
              borderRadius: 12,
              fontSize: 15,
              fontWeight: 600,
              background: "#FFFDF8",
              color: "#5C5345",
              boxShadow: "inset 0 0 0 1.5px #D8CBB2",
            }}
          >
            Cancel
          </button>
          <button
            className="rcb-btn"
            onClick={save}
            style={{
              padding: "12px 24px",
              borderRadius: 12,
              fontSize: 15,
              fontWeight: 700,
              background: "#E4572E",
              color: "#fff",
              boxShadow: "0 8px 22px rgba(228,87,46,.35)",
            }}
          >
            Save key
          </button>
        </div>
      </div>
    </div>
  );
}
