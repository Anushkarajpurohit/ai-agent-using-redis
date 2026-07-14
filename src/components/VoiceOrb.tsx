"use client";

type OrbState = "idle" | "listening" | "thinking" | "speaking";

const PALETTE: Record<OrbState, { core: string; glow: string }> = {
  idle: { core: "linear-gradient(145deg,#6fa697,#4f8a78)", glow: "rgba(79,138,120,0.30)" },
  listening: { core: "linear-gradient(145deg,#63b79f,#3c9a7f)", glow: "rgba(60,154,127,0.50)" },
  thinking: { core: "linear-gradient(145deg,#c9a765,#b0863f)", glow: "rgba(176,134,63,0.42)" },
  speaking: { core: "linear-gradient(145deg,#5aa7d8,#3c7fb8)", glow: "rgba(60,127,184,0.48)" },
};

export default function VoiceOrb({
  state,
  onClick,
}: {
  state: OrbState;
  onClick: () => void;
}) {
  const active = state === "listening" || state === "speaking";
  const { core, glow } = PALETTE[state];

  return (
    <button
      onClick={onClick}
      aria-label="Toggle microphone"
      style={{
        position: "relative",
        width: 168,
        height: 168,
        border: "none",
        background: "transparent",
        cursor: "pointer",
        display: "grid",
        placeItems: "center",
      }}
    >
      {/* radiating rings while voice is flowing */}
      {active &&
        [0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              position: "absolute",
              width: 132,
              height: 132,
              borderRadius: "50%",
              border: `2px solid ${glow}`,
              animation: `ripple 2.4s ${i * 0.8}s ease-out infinite`,
            }}
          />
        ))}

      {/* soft halo */}
      <span
        style={{
          position: "absolute",
          width: 168,
          height: 168,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${glow} 0%, rgba(255,255,255,0) 70%)`,
          filter: "blur(6px)",
        }}
      />

      {/* the core orb */}
      <span
        style={{
          position: "relative",
          width: 132,
          height: 132,
          borderRadius: "50%",
          background: core,
          boxShadow: `0 18px 44px ${glow}, inset 0 6px 16px rgba(255,255,255,0.35), inset 0 -10px 22px rgba(0,0,0,0.14)`,
          display: "grid",
          placeItems: "center",
          animation:
            state === "thinking"
              ? "orbPulse 1.1s ease-in-out infinite"
              : active
                ? "orbPulse 1.8s ease-in-out infinite"
                : "bob 4s ease-in-out infinite",
          transition: "background 0.5s ease",
        }}
      >
        <MicGlyph />
      </span>
    </button>
  );
}

function MicGlyph() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.92 }}>
      <rect x="9" y="3" width="6" height="11" rx="3" fill="#fff" />
      <path
        d="M6 11a6 6 0 0 0 12 0"
        stroke="#fff"
        strokeWidth="1.8"
        strokeLinecap="round"
        fill="none"
      />
      <line x1="12" y1="17" x2="12" y2="21" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
