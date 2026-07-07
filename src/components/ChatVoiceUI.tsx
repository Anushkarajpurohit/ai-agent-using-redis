"use client";

import { useEffect, useRef, useState } from "react";
import VoiceOrb from "./VoiceOrb";

type Role = "maya" | "user";
interface Message {
  role: Role;
  text: string;
  latencyMs?: number;
}

type OrbState = "idle" | "listening" | "thinking" | "speaking";

function getOrCreateSessionId(): string {
  if (typeof window === "undefined") {
    return "";
  }
  const key = "maya_session_id";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}

/**
 * Voice I/O runs entirely IN THE BROWSER via the Web Speech API:
 *   - SpeechRecognition  -> STT, on-device/OS-level, zero network hop
 *   - speechSynthesis    -> TTS, on-device/OS-level, zero network hop
 *
 * There is no /api/voice/stt or /api/voice/tts round trip anymore. The
 * ONLY network call in the whole voice loop is the single /api/chat
 * request to the deterministic orchestrator — which is the one call that
 * actually needs a server, since it owns the DB/cache/state.
 *
 * Supported in Chrome, Edge, and Safari (recent versions). Firefox lacks
 * SpeechRecognition support as of this writing — the UI falls back to
 * typed text automatically when the API isn't present.
 */
export default function ChatVoiceUI() {
  const [messages, setMessages] = useState<Message[]>([
    { role: "maya", text: "Hi, I'm Maya. What symptoms are you having, or who would you like to see today?" },
  ]);
  const [orbState, setOrbState] = useState<OrbState>("idle");
  const [textInput, setTextInput] = useState("");
  // Lazy initializer runs synchronously on the very first render, so
  // sessionId is already correct before any effect (including the
  // SpeechRecognition setup below) captures it in a closure. Previously
  // this was set via a separate useEffect + setState, which meant the
  // SpeechRecognition.onresult closure — created in its own mount-only
  // effect — permanently captured the initial empty string, causing every
  // voice turn to send sessionId="" to /api/chat.
  const [sessionId] = useState(() => getOrCreateSessionId());
  const [speechSupported, setSpeechSupported] = useState(true);
  const recognitionRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // sendToAgent is redefined every render (it closes over current state),
  // so we keep a ref to the latest version and have the SpeechRecognition
  // callback always call through the ref — this makes voice immune to any
  // future stale-closure bugs of the same shape, not just this one.
  const sendToAgentRef = useRef<(text: string) => void>(() => { });
  // Once the user starts talking, this stays "on" like a live call — Maya's
  // mic re-opens automatically after she finishes speaking, instead of
  // requiring a tap for every single turn. Tapping the orb while listening
  // manually "hangs up" (turns this back off).
  const callActiveRef = useRef(false);

  useEffect(() => {
    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      setSpeechSupported(false);
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      sendToAgentRef.current(transcript);
    };

    recognition.onerror = () => {
      setOrbState("idle");
    };

    recognition.onend = () => {
      setOrbState((s) => (s === "listening" ? "idle" : s));
    };

    recognitionRef.current = recognition;
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  function startListening() {
    if (!speechSupported || !recognitionRef.current) return;
    try {
      window.speechSynthesis.cancel(); // don't let Maya's own voice get picked up
      recognitionRef.current.start();
      setOrbState("listening");
    } catch {
      // start() throws if recognition is already running — safe to ignore.
    }
  }

  async function sendToAgent(userText: string) {
    if (!sessionId) return;
    callActiveRef.current = true; // speaking at all means the "call" is live
    setMessages((m) => [...m, { role: "user", text: userText }]);
    setOrbState("thinking");
    const start = performance.now();

    // If the backend takes a while (LLM phrasing, DB round trips), play a
    // short "please hold" filler so the line never goes silent — this does
    // NOT trigger the auto-relisten loop, since we're still waiting for the
    // real answer.
    let settled = false;
    const holdTimer = setTimeout(() => {
      if (!settled) speak("One moment, let me check that for you.", { autoListenAfter: false });
    }, 4000);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message: userText }),
      });
      const data = await res.json();
      settled = true;
      clearTimeout(holdTimer);
      console.log(`[CLIENT] /api/chat round trip: ${Math.round(performance.now() - start)}ms`);

      if (data.error) {
        setMessages((m) => [...m, { role: "maya", text: data.error }]);
        speak(data.error, { autoListenAfter: true });
        return;
      }

      setMessages((m) => [...m, { role: "maya", text: data.reply, latencyMs: data.latencyMs }]);
      speak(data.reply, { autoListenAfter: true });
    } catch (err) {
      settled = true;
      clearTimeout(holdTimer);
      const msg = "Sorry, I lost connection for a moment. Could you say that again?";
      setMessages((m) => [...m, { role: "maya", text: msg }]);
      speak(msg, { autoListenAfter: true });
    }
  }

  useEffect(() => {
    sendToAgentRef.current = sendToAgent;
  });

  function speak(text: string, opts?: { autoListenAfter?: boolean }) {
    if (!("speechSynthesis" in window)) {
      setOrbState("idle");
      if (opts?.autoListenAfter && callActiveRef.current) startListening();
      return;
    }
    window.speechSynthesis.cancel(); // clear any queued utterance (e.g. an in-progress hold message)
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.02;
    utterance.pitch = 1.0;
    utterance.onstart = () => setOrbState("speaking");
    utterance.onend = () => {
      setOrbState("idle");
      // This is the "live call" behavior: once Maya finishes her reply, the
      // mic reopens on its own — the user doesn't have to tap the orb for
      // every single turn, only to start or manually end the call.
      if (opts?.autoListenAfter && callActiveRef.current) startListening();
    };
    utterance.onerror = () => setOrbState("idle");
    window.speechSynthesis.speak(utterance);
  }

  function toggleMic() {
    if (!speechSupported) return;

    if (orbState === "listening") {
      // Manual tap while listening = hang up: stop and don't auto-relisten.
      callActiveRef.current = false;
      recognitionRef.current?.stop();
      return;
    }
    if (orbState !== "idle") return;

    callActiveRef.current = true;
    startListening();
  }

  function handleTextSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!textInput.trim()) return;
    const text = textInput.trim();
    setTextInput("");
    sendToAgent(text);
  }

  return (
    <div
      className="mx-auto flex flex-col"
      style={{ maxWidth: 640, minHeight: "100dvh", padding: "32px 20px" }}
    >
      <header className="flex items-baseline justify-between mb-8">
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: 32, color: "var(--sage)", margin: 0 }}>
          Maya
        </h1>
        <span style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "#8a9a94" }}>
          appointment desk
        </span>
      </header>

      <div className="flex flex-col items-center mb-8 gap-2">
        <VoiceOrb state={orbState} onClick={toggleMic} />
        {!speechSupported && (
          <p style={{ fontSize: 12, color: "#a08a6a", textAlign: "center" }}>
            Voice isn't supported in this browser — try Chrome, Edge, or Safari.
            You can still type below.
          </p>
        )}
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto rounded-2xl mb-4"
        style={{ background: "var(--panel)", border: "1px solid var(--line)", padding: 20 }}
      >
        {messages.map((m, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              justifyContent: m.role === "user" ? "flex-end" : "flex-start",
              marginBottom: 12,
            }}
          >
            <div
              style={{
                maxWidth: "78%",
                padding: "10px 14px",
                borderRadius: 14,
                background: m.role === "user" ? "var(--sage)" : "var(--sage-soft)",
                color: m.role === "user" ? "#fff" : "var(--ink)",
                fontSize: 15,
                lineHeight: 1.4,
              }}
            >
              {m.text}
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={handleTextSubmit} className="flex gap-2">
        <input
          value={textInput}
          onChange={(e) => setTextInput(e.target.value)}
          placeholder="Or type here…"
          style={{
            flex: 1,
            padding: "12px 16px",
            borderRadius: 12,
            border: "1px solid var(--line)",
            background: "var(--panel)",
            fontSize: 15,
            outline: "none",
          }}
        />
        <button
          type="submit"
          style={{
            padding: "12px 20px",
            borderRadius: 12,
            border: "none",
            background: "var(--sage)",
            color: "#fff",
            fontSize: 15,
            cursor: "pointer",
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
