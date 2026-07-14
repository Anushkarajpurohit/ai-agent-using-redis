"use client";

type OrbState = "idle" | "listening" | "thinking" | "speaking";

/**
 * A floating waveform that appears only while voice is actively flowing —
 * either the user is speaking into the mic (listening) or Maya is talking
 * back (speaking). The whole strip drifts (bob) and each bar animates on
 * its own offset so it reads like a living sound wave rather than a chat log.
 */
export default function VoiceWave({ state }: { state: OrbState }) {
    const active = state === "listening" || state === "speaking";
    const tint =
        state === "speaking"
            ? "linear-gradient(180deg,#5aa7d8,#3c7fb8)"
            : "linear-gradient(180deg,#63b79f,#3c9a7f)";

    // deterministic-but-organic set of bar timings
    const bars = Array.from({ length: 28 }, (_, i) => {
        const dur = 0.7 + ((i * 37) % 60) / 100; // 0.7s - 1.3s
        const delay = ((i * 53) % 90) / 100; // 0 - 0.9s
        const base = 0.35 + ((i * 29) % 65) / 100; // baseline scale
        return { dur, delay, base };
    });

    return (
        <div
            aria-hidden
            style={{
                height: 84,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
                opacity: active ? 1 : 0,
                transform: active ? "translateY(0)" : "translateY(14px)",
                transition: "opacity 0.45s ease, transform 0.45s ease",
                animation: active ? "bob 3.4s ease-in-out infinite" : "none",
                pointerEvents: "none",
            }}
        >
            {bars.map((b, i) => (
                <span
                    key={i}
                    style={{
                        width: 4,
                        height: 60,
                        borderRadius: 4,
                        background: tint,
                        transformOrigin: "center",
                        transform: `scaleY(${b.base})`,
                        opacity: 0.85,
                        animation: active
                            ? `waveBar ${b.dur}s ${b.delay}s ease-in-out infinite`
                            : "none",
                    }}
                />
            ))}
        </div>
    );
}




