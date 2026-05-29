"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/*
 * Local text-to-speech.
 *
 * Primary path: Kokoro-82M, a neural voice model, run *locally in the browser
 * on the GPU via WebGPU*. It runs inside a same-origin module Web Worker
 * (`/tts-worker.js`) that imports `kokoro-js` from a CDN at runtime — so the
 * heavy ML libs never enter the bundle. The worker returns raw PCM per
 * sentence; the main thread schedules the chunks back-to-back through the Web
 * Audio API so the first audio starts almost immediately and plays gaplessly.
 *
 * Fallback: the browser's built-in speechSynthesis (OS voices) — instant, no
 * download — used wherever WebGPU is unavailable (Firefox/Safari) or the model
 * can't load. If neither exists, TTS is unsupported and the UI hides it.
 *
 * Nothing here touches a server or an API key.
 */

const VOICE = "af_heart"; // a warm American voice; see kokoro-js list_voices()
const STORE = "recall-circles:voice";

type Engine = "webgpu" | "speech" | "none";
type Status = "idle" | "loading" | "speaking";

export interface TTS {
  supported: boolean;
  engine: Engine;
  enabled: boolean;
  status: Status;
  error: string | null;
  /** True while the neural model is downloading/compiling (first touch). */
  loadingModel: boolean;
  /** 0–100 download progress for the model weights. */
  loadProgress: number;
  toggle: () => void;
  speak: (text: string) => void;
  stop: () => void;
}

export function useTTS(): TTS {
  const [engine, setEngine] = useState<Engine>("none");
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [loadingModel, setLoadingModel] = useState(false);
  const [loadProgress, setLoadProgress] = useState(0);

  const filesRef = useRef<Record<string, { loaded: number; total: number }>>({});

  const engineRef = useRef<Engine>("none");
  const enabledRef = useRef(false);

  const workerRef = useRef<Worker | null>(null);
  const workerReadyRef = useRef<Promise<void> | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const playingRef = useRef(0);
  const nextStartRef = useRef(0);
  const genIdRef = useRef(0);

  /* ---------------------------- engine detect ---------------------------- */
  useEffect(() => {
    let eng: Engine = "none";
    if (typeof navigator !== "undefined" && "gpu" in navigator) eng = "webgpu";
    else if (typeof window !== "undefined" && "speechSynthesis" in window)
      eng = "speech";
    engineRef.current = eng;
    setEngine(eng);
    // eslint-disable-next-line no-console
    console.log("[tts] engine detected:", eng);
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

  // Unlock audio on the first user interaction so autoplay (which fires after an
  // async API call, outside the original gesture) isn't blocked by the browser.
  useEffect(() => {
    const unlock = () => {
      const ctx = ensureCtx();
      ctx?.resume().catch(() => {});
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [ensureCtx]);

  /* ------------------------------ playback ------------------------------- */
  const enqueuePcm = useCallback(
    (pcm: ArrayBuffer, sr: number, forId: number) => {
      const ctx = ctxRef.current;
      if (!ctx || forId !== genIdRef.current) return;
      const f32 = new Float32Array(pcm);
      if (!f32.length) return;
      const buf = ctx.createBuffer(1, f32.length, sr || 24000);
      buf.getChannelData(0).set(f32);
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
    // eslint-disable-next-line no-console
    console.log("[tts] starting worker /tts-worker.js");
    filesRef.current = {};
    setLoadProgress(0);
    setLoadingModel(true);
    const worker = new Worker("/tts-worker.js", { type: "module" });
    workerRef.current = worker;
    worker.addEventListener("message", (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "audio") {
        enqueuePcm(m.pcm as ArrayBuffer, m.sampling_rate as number, m.id as number);
      } else if (m.type === "progress") {
        const d = m.data;
        if (d && d.status === "progress" && d.file && typeof d.total === "number") {
          filesRef.current[d.file] = {
            loaded: Number(d.loaded) || 0,
            total: Number(d.total) || 0,
          };
          let loaded = 0;
          let total = 0;
          for (const k in filesRef.current) {
            loaded += filesRef.current[k].loaded;
            total += filesRef.current[k].total;
          }
          if (total > 0) setLoadProgress(Math.min(99, Math.round((100 * loaded) / total)));
        }
      } else if (m.type === "gen-error") {
        // eslint-disable-next-line no-console
        console.error("[tts] generate error:", m.message);
        setError("The voice hiccuped generating audio. See the console for details.");
        if (m.id === genIdRef.current && playingRef.current <= 0) setStatus("idle");
      }
    });
    workerReadyRef.current = new Promise<void>((resolve, reject) => {
      const onLoad = (e: MessageEvent) => {
        if (e.data.type === "loaded") {
          worker.removeEventListener("message", onLoad);
          // eslint-disable-next-line no-console
          console.log("[tts] model loaded");
          setLoadProgress(100);
          setLoadingModel(false);
          resolve();
        } else if (e.data.type === "load-error") {
          worker.removeEventListener("message", onLoad);
          // eslint-disable-next-line no-console
          console.error("[tts] model load error:", e.data.message);
          setLoadingModel(false);
          reject(new Error(e.data.message));
        }
      };
      worker.addEventListener("message", onLoad);
      worker.postMessage({ type: "load" });
    });
    return workerReadyRef.current;
  }, [enqueuePcm]);

  /* -------------------------------- stop --------------------------------- */
  const stop = useCallback(() => {
    genIdRef.current += 1; // invalidate in-flight chunks
    workerRef.current?.postMessage({ type: "cancel", id: genIdRef.current - 1 });
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
    // eslint-disable-next-line no-console
    console.log("[tts] speaking via browser speechSynthesis");
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
      setError(null);
      const id = genIdRef.current;
      // eslint-disable-next-line no-console
      console.log("[tts] speak()", { engine: engineRef.current, chars: t.length });

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
        setError("GPU voice unavailable — using the browser voice instead.");
        speakWithSpeech(t);
        return;
      }
      if (id !== genIdRef.current) return; // superseded by a newer call
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
      setError(null);
      // Unlock audio inside this gesture and warm the model up so the first
      // real utterance is snappy.
      const ctx = ensureCtx();
      ctx?.resume().catch(() => {});
      if (engineRef.current === "webgpu") {
        ensureWorker().catch(() => {
          engineRef.current = "speech";
          setEngine("speech");
          setError("GPU voice unavailable — using the browser voice instead.");
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
    error,
    loadingModel,
    loadProgress,
    toggle,
    speak,
    stop,
  };
}
