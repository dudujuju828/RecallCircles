import type { QueueItem } from "./types";

/*
 * All persistence is local to the browser. The API key is only ever written
 * when the user opts in to "Remember on this device". The queue is just the
 * user's own notes.
 */

const KEY_STORE = "recall-circles:key";
const QUEUE_STORE = "recall-circles:queue";

const hasWindow = () => typeof window !== "undefined";

/* ------------------------------- API key ------------------------------- */

export function loadKey(): string | null {
  if (!hasWindow()) return null;
  try {
    return window.localStorage.getItem(KEY_STORE);
  } catch {
    return null;
  }
}

export function saveKey(key: string): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(KEY_STORE, key);
  } catch {
    /* ignore quota / disabled storage */
  }
}

export function clearKey(): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.removeItem(KEY_STORE);
  } catch {
    /* ignore */
  }
}

/** Mask a key for display, e.g. sk-ant-…a1b2 */
export function maskKey(key: string): string {
  const k = key.trim();
  if (k.length <= 11) return k;
  return `${k.slice(0, 7)}…${k.slice(-4)}`;
}

/* ------------------------ "look into next" queue ----------------------- */

export function loadQueue(): QueueItem[] {
  if (!hasWindow()) return [];
  try {
    const raw = window.localStorage.getItem(QUEUE_STORE);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (x): x is QueueItem =>
          !!x && typeof x === "object" && typeof (x as QueueItem).text === "string"
      )
      .map((x) => ({
        id: String(x.id ?? cryptoId()),
        text: String(x.text),
        createdAt: Number(x.createdAt) || Date.now(),
        sourceTopic: String(x.sourceTopic ?? ""),
      }));
  } catch {
    return [];
  }
}

export function saveQueue(queue: QueueItem[]): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.setItem(QUEUE_STORE, JSON.stringify(queue));
  } catch {
    /* ignore */
  }
}

export function cryptoId(): string {
  try {
    if (hasWindow() && "randomUUID" in crypto) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
