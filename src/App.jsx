import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import "./App.css";

const API_BASE = "http://127.0.0.1:8000";
const STORAGE_KEY = "stacks_sessions_v1";

function newId() {
  return Math.random().toString(36).slice(2, 9);
}

function loadSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore corrupt storage */
  }
  const first = { id: newId(), label: "New conversation", messages: [], ledger: [] };
  return [first];
}

function saveSessions(sessions) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    /* storage full or unavailable — non-fatal */
  }
}

function topSource(sourcesStr) {
  if (!sourcesStr) return null;
  const first = sourcesStr.split("\n")[0] || "";
  const m = first.match(/-\s*(.+?),\s*page\s*(\S+)/i);
  if (!m) return null;
  return { file: m[1].trim(), page: m[2].trim() };
}

const UNCERTAIN_PHRASES = ["i don't know", "i do not know", "not provided in the text", "not fully listed"];
function isUncertain(text) {
  const t = (text || "").toLowerCase();
  return UNCERTAIN_PHRASES.some((p) => t.includes(p));
}

function titleFromQuestion(q) {
  const trimmed = q.trim();
  return trimmed.length > 42 ? trimmed.slice(0, 42) + "…" : trimmed;
}

// Gemini sometimes emits bullets separated by spaces instead of real line
// breaks (e.g. "...provided). * **Feedback:** ..."), which markdown can't
// parse as a list. Force each "* " bullet onto its own line first.
function normalizeMarkdown(text) {
  if (!text) return text;
  return text
    .replace(/\s+\*\s+(?=\*\*)/g, "\n\n* ")   // "  * **Label:**" -> new line
    .replace(/\s+\*\s+(?=[A-Z])/g, "\n\n* ")  // "  * Some text"  -> new line
    .trim();
}

// ============================================================
// AUDIO QUEUE — Web Audio API, sample-accurate scheduling.
//
// Each incoming WAV chunk is decoded into an AudioBuffer and
// scheduled to start exactly when the previous chunk's audio
// ends (source.start(startAt)). This removes the gap you get
// from repeatedly swapping <audio>.src, which forces a fresh
// load/decode/buffer cycle per chunk.
//
// prebufferCount controls how many chunks are queued up before
// playback starts at all — this is where startup latency is
// absorbed, once, up front, instead of stuttering mid-answer.
// ============================================================

function useAudioQueue(prebufferCount = 3) {
  const audioCtxRef = useRef(null);
  const nextStartTimeRef = useRef(0);
  const scheduledSourcesRef = useRef([]);
  const pendingBuffersRef = useRef([]);
  const hasStartedRef = useRef(false);
  const decodeChainRef = useRef(Promise.resolve());
  const isPausedRef = useRef(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeMessageId, setActiveMessageId] = useState(null);

  function getCtx() {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtxRef.current;
  }

  function scheduleBuffer(audioBuffer) {
    const ctx = getCtx();
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const startAt = Math.max(nextStartTimeRef.current, ctx.currentTime);
    source.start(startAt);
    nextStartTimeRef.current = startAt + audioBuffer.duration;

    scheduledSourcesRef.current.push(source);
    setIsPlaying(true);

    source.onended = () => {
      scheduledSourcesRef.current = scheduledSourcesRef.current.filter((s) => s !== source);
      if (scheduledSourcesRef.current.length === 0) setIsPlaying(false);
    };
  }

  const enqueueChunk = useCallback((dataUrl, messageId) => {
    setActiveMessageId(messageId);
    // Force-resume the AudioContext every time a chunk arrives.
    // Browsers can silently leave it suspended if the earlier
    // user-gesture unlock happened too early or was consumed by
    // something else -- this guarantees playback actually starts
    // without requiring a manual click.
    const ctx = getCtx();
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    // Chain decodes so chunks can never get scheduled out of
    // order even if network/decode timing varies.
    decodeChainRef.current = decodeChainRef.current
      .then(async () => {
        const res = await fetch(dataUrl);
        const arrayBuffer = await res.arrayBuffer();
        const ctx = getCtx();
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

        if (!hasStartedRef.current) {
          pendingBuffersRef.current.push(audioBuffer);
          if (pendingBuffersRef.current.length >= prebufferCount) {
            hasStartedRef.current = true;
            nextStartTimeRef.current = ctx.currentTime;
            const toPlay = pendingBuffersRef.current;
            pendingBuffersRef.current = [];
            toPlay.forEach(scheduleBuffer);
          }
        } else {
          scheduleBuffer(audioBuffer);
        }
      })
      .catch((err) => console.error("Audio decode/schedule failed:", err));
  }, [prebufferCount]);

  const reset = useCallback(() => {
    scheduledSourcesRef.current.forEach((s) => {
      try { s.stop(); } catch { /* already stopped */ }
    });
    scheduledSourcesRef.current = [];
    pendingBuffersRef.current = [];
    hasStartedRef.current = false;
    nextStartTimeRef.current = 0;
    decodeChainRef.current = Promise.resolve();
    isPausedRef.current = false;
    setIsPaused(false);
    setIsPlaying(false);
    setActiveMessageId(null);
  }, []);

  const playAll = useCallback((urls, messageId) => {
    reset();
    setActiveMessageId(messageId);
    hasStartedRef.current = true;

    decodeChainRef.current = urls.reduce(
      (chain, dataUrl) =>
        chain.then(async () => {
          const res = await fetch(dataUrl);
          const arrayBuffer = await res.arrayBuffer();
          const ctx = getCtx();
          const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
          if (nextStartTimeRef.current === 0) nextStartTimeRef.current = ctx.currentTime;
          scheduleBuffer(audioBuffer);
        }),
      Promise.resolve()
    );
  }, [reset]);

  const pause = useCallback(() => {
    const ctx = audioCtxRef.current;
    if (!ctx || isPausedRef.current) return;
    ctx.suspend();
    isPausedRef.current = true;
    setIsPaused(true);
  }, []);

  const resume = useCallback(() => {
    const ctx = audioCtxRef.current;
    if (!ctx || !isPausedRef.current) return;
    ctx.resume();
    isPausedRef.current = false;
    setIsPaused(false);
  }, []);

  const unlockAudio = useCallback(() => {
    const ctx = getCtx();
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
  }, []);

  return { enqueueChunk, playAll, pause, resume, reset, isPaused, isPlaying, activeMessageId, unlockAudio };
}

export default function App() {
  const [sessions, setSessions] = useState(loadSessions);
  const [activeId, setActiveId] = useState(() => loadSessions()[0].id);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [inputMode, setInputMode] = useState("text"); // "text" | "voice"
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const [docs, setDocs] = useState([]);
  const [totalChunks, setTotalChunks] = useState(0);
  const [apiOk, setApiOk] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadNote, setUploadNote] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const { enqueueChunk, playAll, pause, resume, reset, isPaused, isPlaying, activeMessageId, unlockAudio } = useAudioQueue(3);
  const active = sessions.find((s) => s.id === activeId) || sessions[0];

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 15000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    saveSessions(sessions);
  }, [sessions]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [active?.messages]);

  async function checkHealth() {
    try {
      const res = await fetch(API_BASE + "/");
      if (!res.ok) throw new Error();
      setApiOk(true);
      loadDocs();
    } catch {
      setApiOk(false);
    }
  }

  async function loadDocs() {
    try {
      const res = await fetch(API_BASE + "/api/rag/sources");
      const data = await res.json();
      setDocs(data.sources || []);
      setTotalChunks(data.total_chunks || 0);
    } catch {
      /* keep last known list */
    }
  }

  function updateActiveSession(patch) {
    setSessions((prev) => prev.map((s) => (s.id === activeId ? { ...s, ...patch } : s)));
  }

  function startNewSession() {
    const fresh = { id: newId(), label: "New conversation", messages: [], ledger: [] };
    setSessions((prev) => [fresh, ...prev]);
    setActiveId(fresh.id);
    inputRef.current?.focus();
  }

  function switchSession(id) {
    setActiveId(id);
    inputRef.current?.focus();
  }

  function deleteSession(id, e) {
    e.stopPropagation();
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== id);
      if (remaining.length === 0) {
        const fresh = { id: newId(), label: "New conversation", messages: [], ledger: [] };
        setActiveId(fresh.id);
        return [fresh];
      }
      if (id === activeId) setActiveId(remaining[0].id);
      return remaining;
    });
  }

  async function handleUpload(file) {
    if (!file) return;
    if (file.type !== "application/pdf") {
      setUploadNote({ type: "error", text: "Only PDF files are supported." });
      return;
    }
    setUploading(true);
    setUploadNote(null);
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch(API_BASE + "/api/rag/ingest", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "ingest failed");
      setUploadNote({ type: "ok", text: `${data.chunks_added} passages indexed from "${data.filename}".` });
      loadDocs();
    } catch {
      setUploadNote({ type: "error", text: "Couldn't ingest that file — check the backend is running." });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    handleUpload(e.dataTransfer.files[0]);
  }

  async function startRecording() {
    if (recording || transcribing || sending) return;

    unlockAudio();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("Your browser does not support microphone recording.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      audioChunksRef.current = [];

      const mimeTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg"];
      const supportedMimeType = mimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
      const options = supportedMimeType ? { mimeType: supportedMimeType } : undefined;

      const mediaRecorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const audioBlob = new Blob(audioChunksRef.current, {
          type: mediaRecorder.mimeType || "audio/webm",
        });
        await transcribeAudio(audioBlob);
      };

      mediaRecorder.start();
      setRecording(true);
    } catch (error) {
      console.error("Microphone error:", error);
      if (error.name === "NotAllowedError") {
        alert("Microphone permission was denied. Please allow microphone access.");
      } else {
        alert("Could not access the microphone.");
      }
    }
  }

  function stopRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
    setRecording(false);
  }

  async function transcribeAudio(audioBlob) {
    setTranscribing(true);

    try {
      const extension = audioBlob.type.includes("ogg") ? "ogg" : "webm";
      const audioFile = new File([audioBlob], `recording.${extension}`, { type: audioBlob.type });

      const formData = new FormData();
      formData.append("file", audioFile);

      const res = await fetch(API_BASE + "/api/transcribe", { method: "POST", body: formData });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.detail || "Transcription failed");
      }

      const transcript = (data.text || "").trim();

      if (!transcript) {
        alert("Whisper could not detect any speech.");
        return;
      }

      // Voice input gets a voice answer -- send it straight to
      // the combined text+audio endpoint instead of the text box.
      askWithVoice(transcript);
      return;
    } catch (error) {
      console.error("Transcription error:", error);
      alert(error.message || "Could not transcribe the recording.");
    } finally {
      setTranscribing(false);
    }
  }

  // ============================================================
  // VOICE ANSWER
  //
  // /api/rag/chat/voice returns a Server-Sent Events stream with
  // four event types, in this order per request:
  //
  //   event: meta        -> { sources, rewritten_question, images }
  //   event: text_chunk   -> { text }              (many, as Gemini streams)
  //   event: audio_chunk  -> { audio: base64 wav }  (one per finished sentence)
  //   event: done         -> { answer }             (final, once)
  //
  // Text is revealed on a steady timer (independent of how large
  // each network chunk is) so it visibly types out smoothly.
  // Audio chunks are decoded and scheduled gaplessly via
  // useAudioQueue, so both play back "simultaneously" as the
  // requirement asks -- text appears while audio plays, driven
  // by the same single stream.
  // ============================================================

  async function askWithVoice(question) {
    if (!question || sending) return;
    reset();

    const isFirstMessage = active.messages.length === 0;
    const userMsg = { role: "user", text: question };
    const thinkingMsg = { role: "assistant", thinking: true };

    updateActiveSession({
      messages: [...active.messages, userMsg, thinkingMsg],
      label: isFirstMessage ? titleFromQuestion(question) : active.label,
    });
    setInput("");
    setSending(true);

    let revealTimer = null;

    try {
      const res = await fetch(API_BASE + "/api/rag/chat/voice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: active.id, question }),
      });

      if (!res.ok || !res.body) {
        throw new Error("Voice chat request failed");
      }

      let sourcesStr = "";
      let images = [];
      let revealedText = "";
      let pendingText = "";
      const audioBlobUrls = [];

      const placeholderMsgs = [...active.messages, userMsg, {
        role: "assistant",
        text: "",
        uncertain: false,
        rewritten: null,
        source: null,
        images: [],
        audioChunks: [],
        audioLoading: true,
      }];

      setSessions((prev) =>
        prev.map((s) => (s.id === active.id ? { ...s, messages: placeholderMsgs } : s))
      );
      const thisMessageIndex = placeholderMsgs.length - 1;

      function updateAssistantMsg(patch) {
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== active.id) return s;
            const msgs = [...s.messages];
            const current = msgs[thisMessageIndex];
            if (current && current.role === "assistant") {
              msgs[thisMessageIndex] = { ...current, ...patch };
            }
            return { ...s, messages: msgs };
          })
        );
      }

      function startRevealLoop() {
        if (revealTimer) return;
        revealTimer = setInterval(() => {
          if (pendingText.length === 0) return;
          const take = Math.min(2, pendingText.length);
          revealedText += pendingText.slice(0, take);
          pendingText = pendingText.slice(take);
          updateAssistantMsg({ text: revealedText });
        }, 20);
      }

      function flushReveal() {
        if (revealTimer) {
          clearInterval(revealTimer);
          revealTimer = null;
        }
        revealedText += pendingText;
        pendingText = "";
        updateAssistantMsg({ text: revealedText });
      }

      function handleEvent(eventName, dataText) {
        let payload;
        try {
          payload = JSON.parse(dataText);
        } catch {
          return;
        }

        if (eventName === "meta") {
          sourcesStr = payload.sources || "";
          images = payload.images || [];
          updateAssistantMsg({ rewritten: payload.rewritten_question || null });
        }

        if (eventName === "text_chunk") {
          pendingText += payload.text || "";
          startRevealLoop();
        }

        if (eventName === "audio_chunk" && payload.audio) {
          const dataUrl = "data:audio/wav;base64," + payload.audio;
          audioBlobUrls.push(dataUrl);
          enqueueChunk(dataUrl, thisMessageIndex);
          updateAssistantMsg({ audioChunks: [...audioBlobUrls] });
        }

        if (eventName === "done") {
          flushReveal();
          const finalAnswer = payload.answer || revealedText;
          const uncertain = isUncertain(finalAnswer);
          const source = uncertain ? null : topSource(sourcesStr);
          const finalImages = uncertain ? [] : images;

          updateAssistantMsg({
            text: finalAnswer,
            uncertain,
            source,
            images: finalImages,
            audioLoading: false,
          });

          setSessions((prev) =>
            prev.map((s) =>
              s.id === active.id
                ? {
                    ...s,
                    ledger: source ? [source, ...s.ledger].slice(0, 12) : s.ledger,
                    images: finalImages.length
                      ? [...finalImages, ...(s.images || [])]
                          .filter((v, i, a) => a.indexOf(v) === i)
                          .slice(0, 12)
                      : (s.images || []),
                  }
                : s
            )
          );
        }
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });

        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          const lines = rawEvent.split("\n");
          let eventName = "message";
          let dataText = "";

          for (const line of lines) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            if (line.startsWith("data:")) dataText += line.slice(5).trim();
          }

          if (dataText) handleEvent(eventName, dataText);
        }

        if (done) break;
      }
    } catch (error) {
      console.error("Voice chat error:", error);
      const finalMsgs = [...active.messages, userMsg, {
        role: "assistant",
        text: "Couldn't get a voice response just now. Confirm both backend services are running, then try again.",
        error: true,
      }];
      setSessions((prev) =>
        prev.map((s) => (s.id === active.id ? { ...s, messages: finalMsgs } : s))
      );
    } finally {
      if (revealTimer) clearInterval(revealTimer);
      setSending(false);
    }
  }

  async function handleAsk(e) {
    e.preventDefault();
    const question = input.trim();
    if (!question || sending) return;

    const isFirstMessage = active.messages.length === 0;
    const userMsg = { role: "user", text: question };
    const thinkingMsg = { role: "assistant", thinking: true };

    updateActiveSession({
      messages: [...active.messages, userMsg, thinkingMsg],
      label: isFirstMessage ? titleFromQuestion(question) : active.label,
    });
    setInput("");
    setSending(true);

    try {
      const res = await fetch(API_BASE + "/api/rag/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: active.id, question }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "chat failed");

      const uncertain = isUncertain(data.answer);
      const source = uncertain ? null : topSource(data.sources);
      const images = uncertain ? [] : (data.images || []);

      const finalMsgs = [...active.messages, userMsg, {
        role: "assistant",
        text: data.answer,
        uncertain,
        rewritten: data.rewritten_question,
        source,
        images,
      }];

      setSessions((prev) =>
        prev.map((s) =>
          s.id === active.id
            ? {
                ...s,
                messages: finalMsgs,
                ledger: source ? [source, ...s.ledger].slice(0, 12) : s.ledger,
                images: images.length ? [...images, ...(s.images || [])].filter((v, i, a) => a.indexOf(v) === i).slice(0, 12) : (s.images || []),
              }
            : s
        )
      );
    } catch {
      const finalMsgs = [...active.messages, userMsg, {
        role: "assistant",
        text: "Couldn't reach the backend just now. Confirm uvicorn is running, then try again.",
        error: true,
      }];
      setSessions((prev) => prev.map((s) => (s.id === active.id ? { ...s, messages: finalMsgs } : s)));
    } finally {
      setSending(false);
    }
  }  async function handleAsk(e) {
    e.preventDefault();
    const question = input.trim();
    if (!question || sending) return;

    const isFirstMessage = active.messages.length === 0;
    const userMsg = { role: "user", text: question };

    setInput("");
    setSending(true);

    const placeholderMsgs = [...active.messages, userMsg, {
      role: "assistant",
      thinking: true,
      text: "",
      uncertain: false,
      rewritten: null,
      source: null,
      images: [],
    }];

    updateActiveSession({
      messages: placeholderMsgs,
      label: isFirstMessage ? titleFromQuestion(question) : active.label,
    });
    const thisMessageIndex = placeholderMsgs.length - 1;

    let revealTimer = null;
    let revealedText = "";
    let pendingText = "";
    let sourcesStr = "";
    let images = [];
    let rewritten = null;

    function updateAssistantMsg(patch) {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== active.id) return s;
          const msgs = [...s.messages];
          const current = msgs[thisMessageIndex];
          if (current && current.role === "assistant") {
            msgs[thisMessageIndex] = { ...current, ...patch, thinking: false };
          }
          return { ...s, messages: msgs };
        })
      );
    }

    function startRevealLoop() {
      if (revealTimer) return;
      revealTimer = setInterval(() => {
        if (pendingText.length === 0) return;
        const take = Math.min(2, pendingText.length);
        revealedText += pendingText.slice(0, take);
        pendingText = pendingText.slice(take);
        updateAssistantMsg({ text: revealedText });
      }, 20);
    }

    function flushReveal() {
      if (revealTimer) {
        clearInterval(revealTimer);
        revealTimer = null;
      }
      revealedText += pendingText;
      pendingText = "";
      updateAssistantMsg({ text: revealedText });
    }

    try {
      const res = await fetch(API_BASE + "/api/rag/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: active.id, question }),
      });

      if (!res.ok || !res.body) {
        throw new Error("Chat stream request failed");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split("\n\n");
        buffer = events.pop();

        for (const rawEvent of events) {
          const lines = rawEvent.split("\n");
          let eventType = "message";
          let dataStr = "";

          for (const line of lines) {
            if (line.startsWith("event:")) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataStr = line.slice(5).trim();
            }
          }

          if (!dataStr) continue;

          let data;
          try {
            data = JSON.parse(dataStr);
          } catch {
            continue;
          }

          if (eventType === "meta") {
            sourcesStr = data.sources || "";
            images = data.images || [];
            rewritten = data.rewritten_question || null;
          } else if (eventType === "text_chunk") {
            pendingText += data.text || "";
            startRevealLoop();
          } else if (eventType === "done") {
            flushReveal();
            const finalAnswer = data.answer || revealedText;
            const uncertain = isUncertain(finalAnswer);
            const source = uncertain ? null : topSource(sourcesStr);
            const finalImages = uncertain ? [] : images;

            updateAssistantMsg({
              text: finalAnswer,
              uncertain,
              rewritten,
              source,
              images: finalImages,
            });

            setSessions((prev) =>
              prev.map((s) =>
                s.id === active.id
                  ? {
                      ...s,
                      ledger: source ? [source, ...s.ledger].slice(0, 12) : s.ledger,
                      images: finalImages.length
                        ? [...finalImages, ...(s.images || [])]
                            .filter((v, i, a) => a.indexOf(v) === i)
                            .slice(0, 12)
                        : (s.images || []),
                    }
                  : s
              )
            );
          }
        }
      }
    } catch (error) {
      console.error("Chat stream error:", error);
      if (revealTimer) clearInterval(revealTimer);
      const finalMsgs = [...active.messages, userMsg, {
        role: "assistant",
        text: "Couldn't reach the backend just now. Confirm uvicorn is running, then try again.",
        error: true,
      }];
      setSessions((prev) => prev.map((s) => (s.id === active.id ? { ...s, messages: finalMsgs } : s)));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="app">
      {/* LEFT: sessions + source library */}
      <aside className="sidebar">
        <div className="brand"><h1>Stacks<span className="mark">.</span></h1></div>
        <p className="tagline">Upload a document, then ask it anything. Every answer names its shelf and page.</p>

        <label
          className={"upload-box" + (dragOver ? " dragover" : "") + (uploading ? " busy" : "")}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <span className="upload-icon">{uploading ? "…" : "＋"}</span>
          <span className="upload-label">{uploading ? "Reading document…" : "Add a document"}</span>
          <span className="upload-sub">PDF · drag here or click to browse</span>
          <input type="file" accept="application/pdf" ref={fileInputRef} disabled={uploading}
            onChange={(e) => handleUpload(e.target.files[0])} />
        </label>
        {uploadNote && <div className={"upload-note " + uploadNote.type}>{uploadNote.text}</div>}

        <div className="section-label"><span>Shelved</span><span>{docs.length}</span></div>
        <div className="doc-list compact">
          {docs.length === 0 ? (
            <div className="doc-empty">Nothing ingested yet.</div>
          ) : (
            <>
              {docs.map((f) => (
                <div className="doc-card" key={f}>
                  <span className="doc-dot" />
                  <div className="name">{f}</div>
                </div>
              ))}
              <div className="chunk-total">{totalChunks} passages total</div>
            </>
          )}
        </div>

        <div className="section-label" style={{ marginTop: 22 }}>
          <span>Conversations</span>
          <button className="new-chat-btn" onClick={startNewSession}>+ New</button>
        </div>
        <div className="session-list">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={"session-item" + (s.id === activeId ? " active" : "")}
              onClick={() => switchSession(s.id)}
            >
              <span className="session-label">{s.label}</span>
              <button className="session-delete" onClick={(e) => deleteSession(s.id, e)} title="Delete conversation">×</button>
            </div>
          ))}
        </div>

        <div className="api-status">
          <span className={"dot" + (apiOk === null ? "" : apiOk ? " ok" : " bad")} />
          <span>{apiOk === null ? "checking backend…" : apiOk ? "backend connected" : "backend unreachable"}</span>
        </div>
      </aside>

      {/* CENTER: chat */}
      <main className="chat-col">
        <div className="chat-header">
          <h2>Reading room</h2>
          <span className="session-tag">{active.label}</span>
        </div>

        <div className="messages">
          {active.messages.length === 0 ? (
            <div className="empty-state">
              <div className="glyph">§</div>
              <p>Ask a question about anything on the shelf. Each answer names the single passage that best supports it.</p>
            </div>
          ) : (
            active.messages.map((m, i) => (
              <div className={"msg " + m.role} key={i}>
                <div className="who">{m.role === "user" ? "You" : "Stacks"}</div>
                <div className={"bubble" + (m.uncertain ? " uncertain" : "") + (m.error ? " error" : "")}>
                  {m.thinking ? (
                    <span className="thinking"><span className="dot-flash" /><span className="dot-flash" /><span className="dot-flash" /></span>
                  ) : m.role === "assistant" ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                      {normalizeMarkdown(m.text)}
                    </ReactMarkdown>
                  ) : (
                    m.text
                  )}
                </div>
                {m.rewritten && <div className="rewrite-note">↳ read as: {m.rewritten}</div>}
                {m.source && (
                  <div className="cite-strip">
                    <span className="cite-tag">{m.source.file.replace(/\.pdf$/i, "")} <em>p.{m.source.page}</em></span>
                  </div>
                )}
                {m.images && m.images.length > 0 && (
                  <div className="figure-strip">
                    {m.images.map((imgPath, idx) => (
                      <img
                        key={idx}
                        src={API_BASE + "/" + imgPath}
                        alt="Referenced figure"
                        className="figure-img"
                        onError={(e) => { e.target.style.display = "none"; }}
                      />
                    ))}
                  </div>
                )}
                {m.audioChunks && m.audioChunks.length > 0 && (
                  <div className="audio-strip">
                    <button
                      type="button"
                      className="voice-control-btn"
                      onClick={() => {
                        const isThisActive = activeMessageId === i;
                        if (isThisActive && isPaused) {
                          resume();
                        } else if (isThisActive && isPlaying) {
                          pause();
                        } else {
                          playAll(m.audioChunks, i);
                        }
                      }}
                    >
                      {activeMessageId === i && isPaused
                        ? "▶ Resume"
                        : activeMessageId === i && isPlaying
                        ? "⏸ Pause"
                        : "▶ Play voice answer"}
                    </button>
                  </div>
                )}
                {m.audioLoading && (
                  <div className="audio-loading-note">🔊 preparing voice answer…</div>
                )}
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="mode-toggle">
          <button
            type="button"
            className={inputMode === "text" ? "active" : ""}
            onClick={() => setInputMode("text")}
          >
            ⌨ Text
          </button>
          <button
            type="button"
            className={inputMode === "voice" ? "active" : ""}
            onClick={() => setInputMode("voice")}
          >
            🎤 Voice
          </button>
        </div>

        {inputMode === "text" ? (
          <form className="composer" onSubmit={handleAsk}>
            <input
              ref={inputRef}
              type="text"
              placeholder={
                docs.length === 0
                  ? "Add a document before asking…"
                  : "Ask a question about your documents…"
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              autoComplete="off"
              disabled={sending}
            />
            <button type="submit" disabled={sending || !input.trim()}>
              {sending ? "Asking…" : "Ask"}
            </button>
          </form>
        ) : (
          <div className="composer voice-composer">
            <button
              type="button"
              className={"mic-button" + (recording ? " recording" : "")}
              onClick={recording ? stopRecording : startRecording}
              disabled={sending || transcribing}
              title={recording ? "Stop recording" : "Start voice recording"}
            >
              {recording ? "⏹ Stop recording" : "🎤 Tap to speak"}
            </button>
            <span className="voice-status">
              {recording
                ? "Listening…"
                : transcribing
                ? "Transcribing your voice…"
                : sending
                ? "Getting your answer…"
                : "Tap the mic and ask your question"}
            </span>
          </div>
        )}
      </main>

      {/* RIGHT: single-source citation ledger */}
      <aside className="citations">
        <h3>Citation ledger</h3>
        <p className="sub">The single passage behind each recent confident answer, most recent first.</p>
        {active.ledger.length === 0 ? (
          <div className="ledger-empty">Ask a question to see which passage was used to answer it.</div>
        ) : (
          active.ledger.map((s, i) => (
            <div className="ledger-item" key={i}>
              <span className="ledger-index">{String(i + 1).padStart(2, "0")}</span>
              <div>
                <div className="file">{s.file}</div>
                <div className="page">page {s.page}</div>
              </div>
            </div>
          ))
        )}
      </aside>
    </div>
  );
}