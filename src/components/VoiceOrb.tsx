"use client";

type OrbState = "idle" | "listening" | "thinking" | "speaking";

const STATE_LABEL: Record<OrbState, string> = {
  idle: "Tap to speak",
  listening: "Listening…",
  thinking: "Maya is thinking…",
  speaking: "Maya is speaking…",
};

export default function VoiceOrb({
  state,
  onClick,
}: {
  state: OrbState;
  onClick: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <button
        onClick={onClick}
        aria-label={STATE_LABEL[state]}
        className="relative flex items-center justify-center rounded-full focus:outline-none focus-visible:ring-4"
        style={{
          width: 140,
          height: 140,
          background:
            state === "idle"
              ? "var(--sage-soft)"
              : "radial-gradient(circle at 35% 30%, var(--clay), var(--sage))",
          boxShadow:
            state === "listening"
              ? "0 0 0 10px rgba(193,122,84,0.15)"
              : state === "speaking"
              ? "0 0 0 10px rgba(67,99,90,0.15)"
              : "none",
          transition: "box-shadow 300ms ease, background 400ms ease",
        }}
      >
        <span
          className="rounded-full"
          style={{
            width: 56,
            height: 56,
            background: state === "idle" ? "var(--sage)" : "var(--panel)",
            animation:
              state === "listening"
                ? "maya-pulse 1.1s ease-in-out infinite"
                : state === "thinking"
                ? "maya-spin 1.4s linear infinite"
                : state === "speaking"
                ? "maya-pulse 0.6s ease-in-out infinite"
                : "none",
          }}
        />
      </button>
      <p style={{ fontFamily: "var(--font-body)", color: "var(--sage)", fontSize: 14 }}>
        {STATE_LABEL[state]}
      </p>

      <style>{`
        @keyframes maya-pulse {
          0%, 100% { transform: scale(1); opacity: 1; }
          50% { transform: scale(0.75); opacity: 0.7; }
        }
        @keyframes maya-spin {
          0% { transform: rotate(0deg); border-radius: 40%; }
          100% { transform: rotate(360deg); border-radius: 50%; }
        }
      `}</style>
    </div>
  );
}
