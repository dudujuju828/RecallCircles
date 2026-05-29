"use client";

import { useCallback, useEffect, useRef, useState } from "react";

function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

interface Options {
  /** Called with each finalized transcript segment (already trimmed). */
  onFinal: (text: string) => void;
}

interface SpeechState {
  supported: boolean;
  listening: boolean;
  interim: string;
  error: string | null;
  start: () => void;
  stop: () => void;
}

/**
 * Thin wrapper over the browser's Web Speech API. Feature-detects, streams
 * interim + final results, and degrades gracefully (no crash) when the API is
 * missing or mic permission is denied.
 */
export function useSpeechRecognition({ onFinal }: Options): SpeechState {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recRef = useRef<SpeechRecognitionInstance | null>(null);
  const onFinalRef = useRef(onFinal);
  useEffect(() => {
    onFinalRef.current = onFinal;
  }, [onFinal]);

  useEffect(() => {
    setSupported(!!getSpeechRecognition());
  }, []);

  const stop = useCallback(() => {
    const r = recRef.current;
    if (r) {
      try {
        r.onresult = null;
        r.onerror = null;
        r.onend = null;
        r.stop();
      } catch {
        /* ignore */
      }
      recRef.current = null;
    }
    setListening(false);
    setInterim("");
  }, []);

  const start = useCallback(() => {
    const Ctor = getSpeechRecognition();
    if (!Ctor || recRef.current) return;

    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    try {
      r.lang = navigator.language || "en-US";
    } catch {
      r.lang = "en-US";
    }

    r.onresult = (event: SpeechRecognitionEvent) => {
      let finalText = "";
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) finalText += transcript;
        else interimText += transcript;
      }
      if (finalText.trim()) onFinalRef.current(finalText.trim());
      setInterim(interimText);
    };

    r.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setError("Mic access is blocked — you can still type your answer.");
      } else if (event.error !== "no-speech" && event.error !== "aborted") {
        setError("Voice input hiccuped — typing still works.");
      }
      recRef.current = null;
      setListening(false);
      setInterim("");
    };

    r.onend = () => {
      recRef.current = null;
      setListening(false);
      setInterim("");
    };

    try {
      r.start();
      recRef.current = r;
      setListening(true);
      setError(null);
    } catch {
      recRef.current = null;
      setListening(false);
    }
  }, []);

  // Stop cleanly on unmount so recognition never lingers in the background.
  useEffect(() => {
    return () => {
      const r = recRef.current;
      if (r) {
        try {
          r.onresult = null;
          r.onerror = null;
          r.onend = null;
          r.stop();
        } catch {
          /* ignore */
        }
        recRef.current = null;
      }
    };
  }, []);

  return { supported, listening, interim, error, start, stop };
}
