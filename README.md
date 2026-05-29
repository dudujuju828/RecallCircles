# Recall Circles

A branching, active study loop:

1. Type a topic and set **how technical** the explanation should be (a 1–10 slider).
2. Claude writes a short explanation, plus one question about the core idea.
3. You get **3:00 to learn it**; then the explanation is hidden.
4. You answer **one timed open question** (30s — type or speak it).
5. Claude tells you whether you conveyed the **core idea**.
6. **If you got it right**, Claude proposes a slightly adjacent **branch** —
   **Continue** drills into it (the loop repeats, one step deeper each time).
   If not, **give it another go** or **wrap up**.
7. On wrap-up, a calm **reflect** step turns your "what next?" thought-dump into
   clean, studiable questions saved as a reusable queue.

A breadcrumb shows the chain of topics you've branched through this session.

## Bring your own key (BYOK)

This app has **no backend, no database, and no server route that ever sees a
key.** Each user supplies their own Anthropic API key and requests go
**straight from the browser to Anthropic** using the
`anthropic-dangerous-direct-browser-access` header (which is what enables CORS
for browser calls).

- The key lives in React state by default and is gone on refresh.
- Tick **"Remember on this device"** to persist it to `localStorage`
  (`recall-circles:key`) — stored **unencrypted**, as the UI notes.
- **"Forget key"** clears both state and storage. Saved keys are shown masked
  (`sk-ant-…a1b2`).
- Get a key at <https://console.anthropic.com/>.

### Model

Set in `lib/anthropic.ts`:

```ts
export const MODEL = "claude-opus-4-8";
```

`"claude-sonnet-4-6"` is a cheaper, still-excellent alternative for this task —
just change that string.

## Technicality slider

A 1–10 slider on the input screen controls how technical the explanation is,
from plain everyday language up to research-level depth. The value feeds the
generation prompt (`technicalityPrompt` in `lib/constants.ts`) and persists
across branches within a session.

## Voice input

The 30s question (and the reflect dump) support speaking your answer via the
browser's built-in **Web Speech API** — no Whisper, no extra key, no server.
Where it isn't supported (notably Firefox) or mic permission is denied, the mic
hides and typing works as normal.

## The "look into next" queue

The reflect step saves tidied questions to `localStorage`
(`recall-circles:queue`). They appear on the input screen as tappable chips —
tap one to start a new round (it's removed from the queue once used). Items are
deletable individually and clearable in bulk. This is per-device and not synced.

## Local development

```bash
npm install
npm run dev      # http://localhost:3000
```

Open the app, click **🔑 Add your key**, paste your Anthropic key, and go.

## Tech / setup notes

- **Next.js (App Router) + TypeScript**, **Tailwind** (layout) with the
  prototype's inline visual language preserved.
- Animations (timer pulse, background, fades, loading dots) are plain CSS — no
  animation library.
- **Google Fonts** (Fraunces, Newsreader, Hanken Grotesk) are loaded via a
  `<link>` in `app/layout.tsx`'s `<head>` with `preconnect`, so the inline
  styles can reference the families by name. No font files are bundled.
- **Tailwind** is wired through `postcss.config.mjs` + `tailwind.config.ts`;
  directives live at the top of `app/globals.css`.

## Deploy to Vercel

Plain `next build`, **no environment variables required** (BYOK). Import the
repo into Vercel and deploy — the framework preset and build command are
detected automatically. Because every model call uses the visitor's own key,
there is nothing to configure server-side.
