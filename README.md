# Day 23 — Voice RAG Frontend

React chat interface for the Voice RAG system — supports typed
text questions (with live streaming responses) and spoken
questions (with live streaming text + streamed cloned-voice audio
playback), plus document source citations and a per-answer
citation ledger.

## Architecture Overview

This frontend is a **single-page React app** (built with Vite) that
talks to two independent backend services over plain HTTP:

┌───────────────────────────────────────────────────────┐
│ Frontend (this app) │
│ http://localhost:5173 │
└──────────────┬───────────────────────────┬────────────────┘
│ │
│ POST /api/rag/chat/voice │ GET /api/rag/sources
│ POST /api/transcribe │ POST /api/rag/ingest
▼ ▼
┌───────────────────────────────────────────────────────┐
│ Main Backend API — port 8000 │
│ (RAG retrieval + Gemini + Whisper STT) │
└───────────────────────────────────────────────────────┘


The frontend never talks to the TTS service (port 8001) directly —
the main backend API internally calls it and forwards audio through
the same streamed response. See the backend README for details on
that internal call.

---

## 1. Prerequisites

- Node.js 18+ and npm
- The backend running (both services — see `backend/README.md`)

---

## 2. One-Time Setup

```bash
cd frontend
npm install
```

### Environment configuration

The API base URL is currently set directly in `src/App.jsx`:

```js
const API_BASE = "http://127.0.0.1:8000";
```

If you deploy the backend elsewhere, update this constant (or, for
a more production-friendly setup, move it into a `.env` file — see
"Preparing for deployment" below).

---

## 3. Running the Frontend

```bash
cd frontend
npm run dev
```

Wait for:

Local: http://localhost:5173/


Open that URL in your browser. **The backend (both services) must
already be running** — the sidebar will show "backend unreachable"
otherwise, and requests will fail.

---

## 4. Directory Structure

frontend/
│
├── src/
│ ├── App.jsx # entire application — chat UI, mic recording,
│ │ # SSE stream parsing, Web Audio playback scheduler
│ ├── App.css # all styling
│ ├── main.jsx # React entry point
│ └── index.css # global resets
│
├── public/
├── index.html
├── package.json
├── vite.config.js
└── package-lock.json


Everything currently lives in one `App.jsx` file rather than split
into separate component files. This was a deliberate simplicity
choice for this project's size — for a larger app, splitting into
`components/Chat/`, `components/Voice/`, `services/` etc. would be
the next refactor.

---

## 5. Key Features & How They Work

### Text mode vs. Voice mode

A toggle at the bottom of the chat switches between:

- **⌨ Text** — type a question, submit, get a streamed text-only
  answer (no audio generated on the backend, for speed).
- **🎤 Voice** — tap the mic, speak your question, get it
  transcribed (via Whisper), then get a streamed text answer
  **plus** streamed cloned-voice audio that plays automatically.

Both modes call the same backend endpoint
(`POST /api/rag/chat/voice`) — text mode just sends
`"voice": false` in the request body so the backend skips TTS
synthesis entirely.

### Streaming (Server-Sent Events)

`/api/rag/chat/voice` returns a single streamed HTTP response using
the SSE format. The frontend reads the raw response stream, parses
out `event:`/`data:` blocks, and dispatches them:

| Event         | Meaning                                              |
|----------------|-------------------------------------------------------|
| `meta`          | Sources, rewritten follow-up question, referenced images |
| `text_chunk`     | A piece of the answer as Gemini generates it            |
| `audio_chunk`     | Base64-encoded WAV audio for one completed sentence      |
| `done`             | The complete final answer text                          |

Text is revealed on a small interval timer (2 characters every
20ms) rather than dumped in all at once, so it visibly "types out"
even when network chunks arrive in large bursts.

### Audio playback (gapless streaming via Web Audio API)

Rather than using multiple `<audio>` elements (which causes audible
gaps between clips), audio chunks are decoded with the Web Audio
API and scheduled to play back-to-back with sample-accurate timing
(`useAudioQueue` hook in `App.jsx`). A small prebuffer (3 chunks by
default) absorbs startup latency so playback doesn't stutter
mid-sentence.

Playback starts automatically once the prebuffer fills — no click
required for voice-mode questions. A manual "▶ Play voice answer"
button also lets you replay a previous answer's audio on demand.

### Session memory & follow-up questions

Each conversation is a "session" (stored in `localStorage`,
persists across reloads). The backend uses each session's history
to rewrite follow-up questions ("what about its disadvantages?")
into standalone questions before retrieval — the rewritten question
appears as a small note under the answer when this happens.

### Citations

Each confident (non-uncertain) answer shows its source document and
page number as a tag beneath the response, and adds it to the
"Citation ledger" sidebar (most recent 12, right-hand panel).
Referenced figures/images from the source document are shown inline
when relevant.

### Markdown & math rendering

Answers render through `react-markdown` with `remark-gfm` (tables),
`remark-math` + `rehype-katex` (LaTeX equations render as proper
math notation, not raw `$$...$$` text).

---

## 6. Browser Requirements

- **Microphone access** — the browser will prompt for permission on
  first mic use; must be allowed for voice mode to work.
- **Web Audio API** — supported in all modern browsers (Chrome,
  Firefox, Edge, Safari).
- Tested primarily in Chrome.

---

## 7. Preparing for Deployment (Day 25 prep)

Before containerizing/deploying, two things should change:

1. **Move `API_BASE` into an environment variable** instead of a
   hardcoded constant, so the same build can point at different
   backend URLs per environment:

```js
   const API_BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8000";
```

   Then create `frontend/.env`:

VITE_API_BASE=http://127.0.0.1:8000

   (Vite requires the `VITE_` prefix for env vars to be exposed to
   the browser build.)

2. **CORS** — the backend's `CORSMiddleware` currently allows
   `allow_origins=["*"]` (any origin). Once deployed, this should
   be restricted to the frontend's exact deployed domain.

---

## 8. Troubleshooting

**"backend unreachable" in the sidebar**
Confirm the main API (port 8000) is running — this frontend polls
`GET /` every 15 seconds to check.

**Mic button does nothing / permission denied**
Check browser microphone permissions (usually in the address bar's
site settings icon). HTTPS is required for microphone access in
production (localhost is exempt during development).

**Audio doesn't play automatically, requires a click**
This can happen if the browser's autoplay policy suspends the
`AudioContext` before the first real user gesture (like the mic
click) synchronously unlocks it. `unlockAudio()` is called on mic
click for this reason — if audio still doesn't autoplay, check the
browser console for `AudioContext` state warnings.

**Text renders but doesn't visibly "type out"**
For short answers routed through text mode (no TTS), Gemini's
response can stream so fast that the animation is barely visible
— this is expected on fast, short answers, not a bug.

**Tables/equations look like raw text (`| a | b |`, `$$...$$`)**
Confirm `remark-gfm`, `remark-math`, `rehype-katex`, and
`katex/dist/katex.min.css` are all installed and imported in
`App.jsx` — run `npm install remark-gfm remark-math rehype-katex
katex` if missing.
