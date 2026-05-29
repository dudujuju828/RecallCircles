"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/*
 * Local text-to-speech.
 *
 * Primary path: Kokoro-82M, a neural voice model, run *locally in the browser
 * on the GPU via WebGPU*. It loads inside a Web Worker (built from a Blob so it
 * never touches Next's bundler) that dynamically imports `kokoro-js` from a CDN.
 * The model is generated sentence-by-sentence and streamed back, so the first
 * audio starts almost immediately and playback is gapless via the Web Audio API.
 *
 * Fallback: the browser's built-in speechSynthesis (OS voices) — instant, no
 * download — used wherever WebGPU is unavailable (Firefox/Safari). If neither
 * exists, TTS is simply unsupported and the UI hides it.
 *
 * Nothing here touches a server or an API key — it stays consistent with the
 * app's serverless / BYOK design.
 */

const VOICE = "af_heart"; // a warm American voice; see kokoro-js list_voices()
const STORE = "recall-circles:voice";

type Engine = "webgpu" | "speech" | "none";
type Status = "idle" | "loading" | "speaking";

// The worker source. Plain JS, kept as a string so the bundler never processes
// the heavy ML imports — they load from a CDN at runtime instead.
const WORKER_SRC = `
let tts = null;
const cancelled = new Set();

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === "load") {
    try {
      const mod = await import("https://cdn.jsdelivr.net/npm/kokoro-js/+esm");
      const KokoroTTS = mod.KokoroTTS;
      const id = "onnx-community/Kokoro-82M-v1.0-ONNX";
      try {
        tts = await KokoroTTS.from_pretrained(id, { dtype: "fp16", device: "webgpu" });
      } catch (e1) {
        tts = await KokoroTTS.from_pretrained(id, { dtype: "fp32", device: "webgpu" });
      }
      self.postMessage({ type: "loaded" });
    } catch (err) {
      self.postMessage({ type: "load-error", message: String((err && err.message) || err) });
    }
    return;
  }

  if (msg.type === "generate") {
    const id = msg.id;
    try {
      const parts = msg.text.match(/[^.!?]+[.!?]+|\\S[^.!?]*$/g) || [msg.text];
      let i = 0;
      for (const part of parts) {
        if (cancelled.has(id)) break;
        const t = part.trim();
        if (!t) continue;
        const audio = await tts.generate(t, { voice: msg.voice });
        if (cancelled.has(id)) break;
        const raw = audio.toWav();
        const ab = raw instanceof ArrayBuffer ? raw : raw.buffer;
        self.postMessage({ type: "audio", id: id, index: i++, wav: ab }, [ab]);
      }
      self.postMessage({ type: "generated", id: id });
    } catch (err) {
      self.postMessage({ type: "gen-error", id: id, message: String((err && err.message) || err) });
    } finally {
      cancelled.delete(id);
    }
    return;
  }

  if (msg.type === "cancel") {
    cancelled.add(msg.id);
  }
};
`;

let workerBlobUrl: string | null = null;
function getWorkerUrl(): string {
  if (!workerBlobUrl) {
    const blob = new Blob([WORKER_SRC], { type: "text/javascript" });
    workerBlobUrl = URL.createObjectURL(blob);
  }
  return workerBlobUrl;
}

export interface TTS {
  supported: boolean;
  engine: Engine;
  enabled: boolean;
  status: Status;
  toggle: () => void;
  speak: (text: string) => void;
  stop: () => void;
}

export function useTTS(): TTS {
  const [engine, setEngine] = useState<Engine>("none");
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<Status>("idle");

  const engineRef = useRef<Engine>("none");
  const enabledRef = useRef(false);

  const workerRef = useRef<Worker | null>(null);
  const workerReadyRef = useRef<Promise<void> | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const playingRef = useRef(0);
  const nextStartRef = useRef(0);
  const genIdRef = useRef(0);
  const decodeChainRef = useRef<Promise<void>>(Promise.resolve());

  /* ---------------------------- engine detect ---------------------------- */
  useEffect(() => {
    let eng: Engine = "none";
    if (typeof navigator !== "undefined" && "gpu" in navigator) eng = "webgpu";
    else if (typeof window !== "undefined" && "speechSynthesis" in window)
      eng = "speech";
    engineRef.current = eng;
    setEngine(eng);
    try {
      if (eng !== "none" && localStorage.getItem(STORE) === "1") {
        enabledRef.current = true;
        setEnabled(true);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const ensureCtx = useCallback((): AudioContext | null => {
    if (ctxRef.current) return ctxRef.current;
    const Ctor =
      (typeof window !== "undefined" &&
        (window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext)) ||
      null;
    if (!Ctor) return null;
    ctxRef.current = new Ctor();
    return ctxRef.current;
  }, []);

  /* ------------------------------ playback ------------------------------- */
  const enqueueWav = useCallback(
    async (wav: ArrayBuffer, forId: number) => {
      const ctx = ctxRef.current;
      if (!ctx || forId !== genIdRef.current) return;
      let buf: AudioBuffer;
      try {
        buf = await ctx.decodeAudioData(wav);
      } catch {
        return;
      }
      if (forId !== genIdRef.current) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const start = Math.max(ctx.currentTime, nextStartRef.current);
      src.start(start);
      nextStartRef.current = start + buf.duration;
      playingRef.current += 1;
      setStatus("speaking");
      src.onended = () => {
        playingRef.current -= 1;
        sourcesRef.current = sourcesRef.current.filter((s) => s !== src);
        if (playingRef.current <= 0) setStatus("idle");
      };
      sourcesRef.current.push(src);
    },
    []
  );

  const ensureWorker = useCallback((): Promise<void> => {
    if (workerReadyRef.current) return workerReadyRef.current;
    const worker = new Worker(getWorkerUrl(), { type: "module" });
    workerRef.current = worker;
    worker.addEventListener("message", (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "audio") {
        const ab = m.wav as ArrayBuffer;
        const forId = m.id as number;
        decodeChainRef.current = decodeChainRef.current
          .then(() => enqueueWav(ab, forId))
          .catch(() => {});
      } else if (m.type === "gen-error") {
        if (m.id === genIdRef.current && playingRef.current <= 0) setStatus("idle");
      }
    });
    workerReadyRef.current = new Promise<void>((resolve, reject) => {
      const onLoad = (e: MessageEvent) => {
        if (e.data.type === "loaded") {
          worker.removeEventListener("message", onLoad);
          resolve();
        } else if (e.data.type === "load-error") {
          worker.removeEventListener("message", onLoad);
          reject(new Error(e.data.message));
        }
      };
      worker.addEventListener("message", onLoad);
      worker.postMessage({ type: "load" });
    });
    return workerReadyRef.current;
  }, [enqueueWav]);

  /* -------------------------------- stop --------------------------------- */
  const stop = useCallback(() => {
    genIdRef.current += 1; // invalidate in-flight chunks
    if (workerRef.current) {
      workerRef.current.postMessage({ type: "cancel", id: genIdRef.current - 1 });
    }
    sourcesRef.current.forEach((s) => {
      try {
        s.onended = null;
        s.stop();
      } catch {
        /* ignore */
      }
    });
    sourcesRef.current = [];
    playingRef.current = 0;
    if (ctxRef.current) nextStartRef.current = ctxRef.current.currentTime;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setStatus("idle");
  }, []);

  /* ------------------------------ speak ---------------------------------- */
  const speakWithSpeech = useCallback((text: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    u.onstart = () => setStatus("speaking");
    u.onend = () => setStatus("idle");
    u.onerror = () => setStatus("idle");
    window.speechSynthesis.speak(u);
  }, []);

  const speak = useCallback(
    async (text: string) => {
      const t = (text || "").trim();
      if (!t || engineRef.current === "none") return;
      stop();
      const id = genIdRef.current;

      if (engineRef.current === "speech") {
        speakWithSpeech(t);
        return;
      }

      // WebGPU neural path.
      const ctx = ensureCtx();
      if (ctx) {
        try {
          await ctx.resume();
        } catch {
          /* ignore */
        }
      }
      setStatus("loading");
      try {
        await ensureWorker(); // downloads + compiles the model the first time
      } catch {
        // Model couldn't load — fall back to the OS voice from here on.
        engineRef.current = "speech";
        setEngine("speech");
        speakWithSpeech(t);
        return;
      }
      if (id !== genIdRef.current) return; // superseded by a newer call
      decodeChainRef.current = Promise.resolve();
      if (ctx) nextStartRef.current = ctx.currentTime;
      workerRef.current?.postMessage({ type: "generate", id, text: t, voice: VOICE });
    },
    [ensureCtx, ensureWorker, speakWithSpeech, stop]
  );

  /* ------------------------------ toggle --------------------------------- */
  const toggle = useCallback(() => {
    const next = !enabledRef.current;
    enabledRef.current = next;
    setEnabled(next);
    try {
      localStorage.setItem(STORE, next ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (next) {
      // Unlock audio inside this user gesture and warm the model up so the
      // first real utterance is snappy.
      const ctx = ensureCtx();
      ctx?.resume().catch(() => {});
      if (engineRef.current === "webgpu") {
        ensureWorker().catch(() => {
          engineRef.current = "speech";
          setEngine("speech");
        });
      }
    } else {
      stop();
    }
  }, [ensureCtx, ensureWorker, stop]);

  /* ------------------------------ cleanup -------------------------------- */
  useEffect(() => {
    return () => {
      genIdRef.current += 1;
      sourcesRef.current.forEach((s) => {
        try {
          s.onended = null;
          s.stop();
        } catch {
          /* ignore */
        }
      });
      sourcesRef.current = [];
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
      workerRef.current?.terminate();
      workerRef.current = null;
      workerReadyRef.current = null;
      ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
    };
  }, []);

  return {
    supported: engine !== "none",
    engine,
    enabled,
    status,
    toggle,
    speak,
    stop,
  };
}
