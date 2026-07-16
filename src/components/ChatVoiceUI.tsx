"use client";

/**
 * ChatVoiceUI — server-side STT + TTS edition
 *
 * Voice I/O pipeline:
 *   Mic (MediaRecorder → WebM blob, turn-taking decided by Silero VAD)
 *     → POST /api/stt  (proxied to local faster-whisper Docker sidecar)
 *     → text  →  POST /api/chat  (orchestrator — UNCHANGED)
 *     → reply text  →  POST /api/tts  (msedge-tts, Microsoft neural voice)
 *     → audio/mpeg  →  <Audio>.play()
 *
 * Works in ALL browsers (Chrome, Firefox, Safari, Edge) because MediaRecorder
 * and the Fetch API are universal — no Web Speech API required.
 *
 * Turn-taking (when to stop recording) is decided by @ricky0123/vad-web, a
 * local, free, in-browser Silero VAD model — not an amplitude/silence timer.
 * It runs on-device (ONNX/WASM, assets self-hosted from public/vad/, no
 * network call), and actually classifies speech vs. non-speech per frame
 * instead of guessing from volume, which is what was cutting people off
 * mid-sentence on an ordinary pause.
 */

import { useEffect, useRef, useState } from "react";
import { MicVAD } from "@ricky0123/vad-web";
import VoiceOrb from "./VoiceOrb";
import VoiceWave from "./VoiceWave";

type Role = "maya" | "user";
interface Message {
  role: Role;
  text: string;
  latencyMs?: number;
}

type OrbState = "idle" | "listening" | "thinking" | "speaking";

const GREETING =
  "Hi, I'm Maya. What symptoms are you having, or who would you like to see today?";

function getOrCreateSessionId(): string {
  if (typeof window === "undefined") return "";
  const key = "maya_session_id";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}

const CAPTION: Record<OrbState, string> = {
  idle: "Tap to talk",
  listening: "Listening…",
  thinking: "One moment…",
  speaking: "Maya is speaking",
};

// Turn-taking tuning
const VAD_REDEMPTION_MS = 700;    // ms of VAD-judged silence after real speech before ending the turn
const MAX_RECORDING_MS = 30_000;  // absolute safety cap regardless of VAD, e.g. if the model fails to load

export default function ChatVoiceUI() {
  const [messages, setMessages] = useState<Message[]>([
    { role: "maya", text: GREETING },
  ]);
  const [orbState, setOrbState] = useState<OrbState>("idle");
  const [textInput, setTextInput] = useState("");
  const [showTranscript, setShowTranscript] = useState(false);
  const [showKeyboard, setShowKeyboard] = useState(false);
  const [sessionId] = useState(() => getOrCreateSessionId());
  const [micSupported, setMicSupported] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const callActiveRef = useRef(false);
  const sendToAgentRef = useRef<(text: string) => void>(() => { });

  // Mirrors orbState synchronously. The conversational auto-continue chain
  // (speak() -> finish() -> startListening()) runs across awaits inside
  // closures captured at various past renders, so reading React's `orbState`
  // there is stale — it never reflects the setOrbState() calls made earlier
  // in the very same chain. This ref is updated in lockstep via
  // setOrb() below and is what internal readiness guards check instead.
  const orbStateRef = useRef<OrbState>("idle");
  function setOrb(next: OrbState) {
    orbStateRef.current = next;
    setOrbState(next);
  }

  // MediaRecorder state
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  // Turn-taking (Silero VAD) + absolute safety cap
  const vadRef = useRef<MicVAD | null>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Current TTS playback
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  // Bumped on every speak() call so a slower, superseded call (e.g. the
  // "one moment..." filler racing the real reply that arrived while it was
  // still fetching) can detect it's stale and skip playing instead of
  // talking over whichever call started after it.
  const speakGenRef = useRef(0);

  // ─── lifecycle ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicSupported(false);
    }
  }, []);

  // Auto-greet ~400 ms after mount
  useEffect(() => {
    const t = setTimeout(() => {
      callActiveRef.current = true;
      speak(GREETING, { autoListenAfter: true });
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll transcript
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, showTranscript]);

  // Keep sendToAgentRef up-to-date each render
  useEffect(() => {
    sendToAgentRef.current = sendToAgent;
  });

  // ─── recording ───────────────────────────────────────────────────────────

  async function startListening() {
    if (!micSupported || orbStateRef.current !== "idle") return;

    // Interrupt any playing TTS
    stopAudio();

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.error("[MIC] getUserMedia failed:", err);
      setMicSupported(false);
      return;
    }
    streamRef.current = stream;

    // Pick a supported MIME type
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";

    const recorder = new MediaRecorder(stream, { mimeType });
    recorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = async () => {
      cleanupMic();
      const blob = new Blob(chunksRef.current, { type: mimeType });
      if (blob.size < 500) {
        // Essentially empty recording — skip
        if (callActiveRef.current) {
          setOrb("idle");
          startListening();
        }
        return;
      }
      await sendAudioToSTT(blob);
    };

    recorder.start(100); // deliver data every 100 ms
    setOrb("listening");

    // Voice-activity detection decides when the user is actually done
    // speaking — a real per-frame speech/non-speech classification, not an
    // amplitude threshold — instead of stopRecording() firing off a blind
    // silence timer. Shares the same MediaStream as the recorder above, so
    // permission is only requested once and both consume the same mic.
    try {
      const vad = await MicVAD.new({
        baseAssetPath: "/vad/",
        onnxWASMBasePath: "/vad/",
        getStream: async () => stream,
        // Default pauseStream stops the shared stream's tracks, which would
        // cut MediaRecorder off too — we own the stream's lifecycle via
        // cleanupMic() instead, so make VAD's own pause/resume a no-op on it.
        pauseStream: async () => { },
        resumeStream: async () => stream,
        redemptionMs: VAD_REDEMPTION_MS,
        onSpeechEnd: () => stopRecording(),
        onVADMisfire: () => {
          // Too short to be real speech (a click, a cough) — keep listening.
        },
      });
      vadRef.current = vad;
    } catch (err) {
      console.error("[VAD] failed to load — falling back to the safety timer only:", err);
    }

    // Absolute safety cap regardless of VAD (e.g. if it failed to load).
    maxTimerRef.current = setTimeout(() => stopRecording(), MAX_RECORDING_MS);
  }

  function stopRecording() {
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    if (vadRef.current) {
      const vad = vadRef.current;
      vadRef.current = null;
      // Deferred so destroy() doesn't tear down VAD state from inside its
      // own onSpeechEnd callback's call stack.
      setTimeout(() => void vad.destroy(), 0);
    }
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop(); // triggers recorder.onstop
    }
  }

  function cleanupMic() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  // ─── STT ─────────────────────────────────────────────────────────────────

  async function sendAudioToSTT(blob: Blob) {
    setOrb("thinking");
    const form = new FormData();
    form.append("audio", blob, "recording.webm");

    try {
      const res = await fetch("/api/stt", { method: "POST", body: form });
      const data = await res.json();
      const transcript: string = data.transcript?.trim() ?? "";

      if (!transcript) {
        // Nothing recognised — go back to idle and re-listen if call is live
        setOrb("idle");
        if (callActiveRef.current) startListening();
        return;
      }

      await sendToAgentRef.current(transcript);
    } catch (err) {
      console.error("[STT fetch] error:", err);
      setOrb("idle");
    }
  }

  // ─── /api/chat ───────────────────────────────────────────────────────────

  async function sendToAgent(userText: string) {
    if (!sessionId) return;
    callActiveRef.current = true;
    setMessages((m) => [...m, { role: "user", text: userText }]);
    setOrb("thinking");

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

      if (data.error) {
        setMessages((m) => [...m, { role: "maya", text: data.error }]);
        speak(data.error, { autoListenAfter: true });
        return;
      }

      setMessages((m) => [
        ...m,
        { role: "maya", text: data.reply, latencyMs: data.latencyMs },
      ]);
      speak(data.reply, { autoListenAfter: true });
    } catch {
      settled = true;
      clearTimeout(holdTimer);
      const fallback = "Sorry, I lost connection for a moment. Could you say that again?";
      setMessages((m) => [...m, { role: "maya", text: fallback }]);
      speak(fallback, { autoListenAfter: true });
    }
  }

  // ─── TTS ─────────────────────────────────────────────────────────────────

  /** Browser-native fallback so the agent is never silent just because the
   *  network TTS call failed (e.g. Edge TTS unreachable) — lower quality,
   *  but always available offline/locally. */
  function speakWithBrowserVoice(text: string): Promise<void> {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return resolve();
      const utter = new SpeechSynthesisUtterance(text);
      utter.onend = () => resolve();
      utter.onerror = () => resolve();
      window.speechSynthesis.speak(utter);
    });
  }

  async function speak(text: string, opts?: { autoListenAfter?: boolean }) {
    const myGen = ++speakGenRef.current;
    const stillCurrent = () => myGen === speakGenRef.current;

    setOrb("speaking");
    stopAudio(); // cancel any previous playback

    const finish = () => {
      if (!stillCurrent()) return;
      setOrb("idle");
      if (opts?.autoListenAfter && callActiveRef.current) startListening();
    };

    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (!res.ok) throw new Error(`TTS ${res.status}`);

      const blob = await res.blob();
      if (!stillCurrent()) return; // a newer speak() call has since taken over

      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudioRef.current = audio;

      const onDone = () => {
        URL.revokeObjectURL(url);
        if (currentAudioRef.current === audio) currentAudioRef.current = null;
        finish();
      };

      audio.onended = onDone;
      audio.onerror = (e) => {
        console.error("[TTS audio]", e);
        onDone();
      };

      await audio.play();
    } catch (err) {
      console.error("[TTS fetch] error:", err);
      if (!stillCurrent()) return;
      await speakWithBrowserVoice(text);
      finish();
    }
  }

  function stopAudio() {
    if (currentAudioRef.current) {
      // Clearing src below fires a spurious `error` event on the element;
      // detach the handlers first so it doesn't get logged as a real failure.
      currentAudioRef.current.onerror = null;
      currentAudioRef.current.onended = null;
      currentAudioRef.current.pause();
      currentAudioRef.current.src = "";
      currentAudioRef.current = null;
    }
  }

  // ─── UI handlers ─────────────────────────────────────────────────────────

  function toggleMic() {
    if (orbStateRef.current === "listening") {
      callActiveRef.current = false; // manual hang-up
      stopRecording();
      return;
    }
    if (orbStateRef.current !== "idle") return;
    callActiveRef.current = true;
    startListening();
  }

  function endCall() {
    callActiveRef.current = false;
    stopAudio();
    stopRecording();
    setOrb("idle");
  }

  function handleTextSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!textInput.trim()) return;
    const text = textInput.trim();
    setTextInput("");
    sendToAgent(text);
  }

  // ─── derived ─────────────────────────────────────────────────────────────

  const lastMaya = [...messages].reverse().find((m) => m.role === "maya");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const callLive = callActiveRef.current && orbState !== "idle";

  // ─── render ──────────────────────────────────────────────────────────────

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "28px 20px 32px",
      }}
    >
      {/* ambient floating blobs */}
      <div aria-hidden style={blob(-80, -60, 320, "rgba(99,183,159,0.22)", "drift 18s ease-in-out infinite")} />
      <div aria-hidden style={blob(undefined, undefined, 380, "rgba(90,167,216,0.16)", "drift 22s ease-in-out infinite", { right: -120, bottom: -80 })} />

      <div style={{ width: "100%", maxWidth: 560, display: "flex", flexDirection: "column", flex: 1, position: "relative" }}>

        {/* header */}
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                background: callLive ? "#3c9a7f" : "#b9c7c1",
                boxShadow: callLive ? "0 0 0 4px rgba(60,154,127,0.18)" : "none",
                transition: "all 0.3s ease",
              }}
            />
            <div>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 22, color: "var(--sage-deep)", lineHeight: 1 }}>
                Maya
              </div>
              <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)" }}>
                appointment desk
              </div>
            </div>
          </div>
          <span style={{ fontSize: 12, color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>
            {callLive ? "on call" : "ready"}
          </span>
        </header>

        {/* ── Voice stage ── */}
        <section
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 18,
            textAlign: "center",
            paddingBottom: 8,
          }}
        >
          <VoiceWave state={orbState} />
          <VoiceOrb state={orbState} onClick={toggleMic} />

          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--sage-deep)", letterSpacing: "0.02em" }}>
            {micSupported ? CAPTION[orbState] : "Voice unavailable — type below"}
          </div>

          {/* Live caption */}
          <div style={{ minHeight: 88, maxWidth: 440, display: "grid", placeItems: "center" }}>
            <p
              key={lastMaya?.text}
              style={{
                margin: 0,
                fontFamily: "var(--font-display)",
                fontSize: 21,
                lineHeight: 1.42,
                color: "var(--ink)",
                animation: "fadeIn 0.5s ease",
              }}
            >
              {lastMaya?.text ?? GREETING}
            </p>
          </div>

          {lastUser && (
            <p
              key={lastUser.text}
              style={{
                margin: 0,
                fontSize: 13,
                color: "var(--muted)",
                fontStyle: "italic",
                animation: "fadeIn 0.4s ease",
              }}
            >
              you said: &ldquo;{lastUser.text}&rdquo;
            </p>
          )}
        </section>

        {!micSupported && (
          <p style={{ fontSize: 12, color: "#a08a6a", textAlign: "center", marginTop: 0 }}>
            Microphone access isn&apos;t available in this context — use the keyboard input below.
          </p>
        )}

        {/* ── Controls ── */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginTop: 10 }}>
          <PillButton onClick={() => setShowKeyboard((v) => !v)} active={showKeyboard}>
            ⌨︎ Type
          </PillButton>
          <PillButton onClick={() => setShowTranscript((v) => !v)} active={showTranscript}>
            ❝ Transcript
          </PillButton>
          {callLive && (
            <PillButton onClick={endCall} danger>
              ✕ End
            </PillButton>
          )}
        </div>

        {/* Keyboard fallback */}
        {showKeyboard && (
          <form onSubmit={handleTextSubmit} style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <input
              autoFocus
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="Type your message…"
              style={{
                flex: 1,
                padding: "12px 16px",
                borderRadius: 14,
                border: "1px solid var(--line)",
                background: "rgba(255,255,255,0.85)",
                fontSize: 15,
                outline: "none",
                color: "var(--ink)",
              }}
            />
            <button
              type="submit"
              style={{
                padding: "12px 20px",
                borderRadius: 14,
                border: "none",
                background: "var(--sage)",
                color: "#fff",
                fontSize: 15,
                cursor: "pointer",
                fontWeight: 500,
              }}
            >
              Send
            </button>
          </form>
        )}

        {/* Collapsible transcript */}
        {showTranscript && (
          <div
            ref={scrollRef}
            style={{
              marginTop: 12,
              maxHeight: 240,
              overflowY: "auto",
              borderRadius: 16,
              background: "var(--panel)",
              backdropFilter: "blur(8px)",
              border: "1px solid var(--line)",
              padding: 16,
            }}
          >
            {messages.map((m, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  justifyContent: m.role === "user" ? "flex-end" : "flex-start",
                  marginBottom: 10,
                }}
              >
                <div
                  style={{
                    maxWidth: "80%",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: m.role === "user" ? "flex-end" : "flex-start",
                  }}
                >
                  <div
                    style={{
                      padding: "8px 12px",
                      borderRadius: 12,
                      background: m.role === "user" ? "var(--sage)" : "var(--sage-soft)",
                      color: m.role === "user" ? "#fff" : "var(--ink)",
                      fontSize: 14,
                      lineHeight: 1.4,
                    }}
                  >
                    {m.text}
                  </div>
                  {m.latencyMs != null && (
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--muted, #888)",
                        marginTop: 2,
                        padding: "0 2px",
                      }}
                    >
                      {m.latencyMs} ms
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

// ─── sub-components ──────────────────────────────────────────────────────────

function PillButton({
  children,
  onClick,
  active,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "8px 16px",
        borderRadius: 999,
        border: `1px solid ${danger ? "rgba(190,70,70,0.3)" : "var(--line)"}`,
        background: danger
          ? "rgba(190,70,70,0.10)"
          : active
            ? "var(--sage-soft)"
            : "rgba(255,255,255,0.7)",
        color: danger ? "#b34646" : active ? "var(--sage-deep)" : "var(--muted)",
        fontSize: 13,
        fontWeight: 500,
        cursor: "pointer",
        transition: "all 0.2s ease",
      }}
    >
      {children}
    </button>
  );
}

function blob(
  top: number | undefined,
  left: number | undefined,
  size: number,
  color: string,
  animation: string,
  extra?: React.CSSProperties
): React.CSSProperties {
  return {
    position: "fixed",
    top,
    left,
    width: size,
    height: size,
    borderRadius: "50%",
    background: `radial-gradient(circle, ${color} 0%, rgba(255,255,255,0) 70%)`,
    filter: "blur(10px)",
    zIndex: 0,
    animation,
    pointerEvents: "none",
    ...extra,
  };
}
