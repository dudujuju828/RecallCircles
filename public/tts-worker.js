// Recall Circles — local neural TTS worker.
//
// Runs Kokoro-82M on WebGPU via kokoro-js, which is imported from a CDN at
// runtime so the heavy ML libs never enter the app bundle. Served as a real
// same-origin module worker (not a Blob) so cross-origin dynamic import() is
// reliable. Posts back raw PCM per sentence for gapless playback on the main
// thread.
//
// Diagnostics are logged with the "[tts-worker]" prefix — open DevTools to see
// exactly where things succeed or fail.

let tts = null;
const cancelled = new Set();
const log = (...a) => console.log("[tts-worker]", ...a);

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === "load") {
    try {
      log("WebGPU present in worker:", "gpu" in navigator);
      log("importing kokoro-js from CDN…");
      const { KokoroTTS } = await import(
        "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm"
      );
      const modelId = "onnx-community/Kokoro-82M-v1.0-ONNX";
      let lastErr = null;
      for (const dtype of ["fp32", "fp16"]) {
        try {
          log("loading model", dtype, "on webgpu (first time downloads weights)…");
          tts = await KokoroTTS.from_pretrained(modelId, {
            dtype,
            device: "webgpu",
            // Report download progress so the UI can show a real loading bar.
            progress_callback: (p) => self.postMessage({ type: "progress", data: p }),
          });
          log("model ready:", dtype);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          log("load attempt failed:", dtype, String((err && err.message) || err));
        }
      }
      if (!tts) throw lastErr || new Error("model failed to load");
      self.postMessage({ type: "loaded" });
    } catch (err) {
      log("LOAD ERROR:", String((err && err.message) || err));
      self.postMessage({ type: "load-error", message: String((err && err.message) || err) });
    }
    return;
  }

  if (msg.type === "generate") {
    const id = msg.id;
    try {
      const parts = msg.text.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [msg.text];
      let i = 0;
      for (const part of parts) {
        if (cancelled.has(id)) break;
        const t = part.trim();
        if (!t) continue;
        const audio = await tts.generate(t, { voice: msg.voice });
        if (cancelled.has(id)) break;
        const f32 =
          audio.audio instanceof Float32Array
            ? audio.audio
            : new Float32Array(audio.audio);
        const copy = f32.slice(); // own buffer, exact length, transferable
        log("chunk", i, "samples", copy.length, "sr", audio.sampling_rate);
        self.postMessage(
          { type: "audio", id, index: i++, pcm: copy.buffer, sampling_rate: audio.sampling_rate },
          [copy.buffer]
        );
      }
      self.postMessage({ type: "generated", id });
    } catch (err) {
      log("GENERATE ERROR:", String((err && err.message) || err));
      self.postMessage({ type: "gen-error", id, message: String((err && err.message) || err) });
    } finally {
      cancelled.delete(id);
    }
    return;
  }

  if (msg.type === "cancel") cancelled.add(msg.id);
};
