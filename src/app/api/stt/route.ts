/**
 * POST /api/stt
 *
 * Accepts a multipart/form-data request with an "audio" blob (WebM/Ogg) and
 * returns { transcript: string }.
 *
 * Provider selection:
 *   - If GROQ_API_KEY is set, uses Groq's hosted Whisper endpoint
 *     (api.groq.com/openai/v1/audio/transcriptions) — free-tier, very low
 *     latency (Groq's inference hardware), no infra to keep alive. This is
 *     the primary path in production (Railway) since self-hosting the
 *     whisper sidecar there has been unreliable.
 *   - Otherwise falls back to a local/self-hosted OpenAI-compatible whisper
 *     server via WHISPER_URL, e.g.:
 *       docker run -d --name whisper-server -p 8000:8000 \
 *         -e WHISPER__MODEL=base.en \
 *         fedirz/faster-whisper-server:latest-cpu
 */

import { NextRequest, NextResponse } from "next/server";

const GROQ_API_KEY = process.env.GROQ_API_KEYY;
const GROQ_STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
// whisper-large-v3-turbo: Groq's best latency/accuracy tradeoff for
// real-time voice — large-v3 accuracy at a fraction of large-v3's latency.
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo";

const WHISPER_URL =
  process.env.WHISPER_URL || "https://faster-whisper-server-production-b4f0.up.railway.app/v1/audio/transcriptions";

/**
 * Whisper-family models hallucinate short filler phrases ("Okay.", "All
 * right.", "Thank you.") repeated dozens of times when fed audio that's
 * mostly silence/noise — a known failure mode, not a real utterance. If a
 * short phrase dominates the transcript, treat it as noise rather than
 * forwarding it to the orchestrator as something the caller actually said.
 */
function isHallucinatedRepeat(text: string): boolean {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/[.!?]+$/, "").trim().toLowerCase())
    .filter(Boolean);

  if (sentences.length < 5) return false;

  const counts = new Map<string, number>();
  for (const s of sentences) counts.set(s, (counts.get(s) ?? 0) + 1);
  const [mostCommon, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];

  const wordCount = mostCommon.split(/\s+/).filter(Boolean).length;
  return wordCount <= 4 && count / sentences.length >= 0.7;
}

export async function POST(req: NextRequest) {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const audio = formData.get("audio");
  if (!audio || !(audio instanceof Blob)) {
    return NextResponse.json({ error: "Missing 'audio' blob" }, { status: 400 });
  }

  const useGroq = Boolean(GROQ_API_KEY);
  const url = useGroq ? GROQ_STT_URL : WHISPER_URL;

  const form = new FormData();
  form.append("file", audio, "audio.webm");
  // "model" is required by the OpenAI API shape. The local whisper sidecar
  // ignores it (runs whatever it was started with) but still needs the
  // field present; Groq actually dispatches on it, so it must be a real
  // Groq model id.
  form.append("model", useGroq ? GROQ_STT_MODEL : "whisper-1");
  form.append("language", process.env.WHISPER_LANGUAGE ?? "en");
  form.append("response_format", "json");

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: useGroq ? { Authorization: `Bearer ${GROQ_API_KEY}` } : undefined,
      body: form,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");

      console.error(`[STT] ${useGroq ? "Groq" : "whisper server"} ${res.status}: ${body}`);
      throw new Error(`STT provider returned ${res.status}`);
    }

    const data = await res.json();
    let transcript: string = data.text?.trim() ?? "";

    if (transcript && isHallucinatedRepeat(transcript)) {
      console.warn(`[STT] discarding likely hallucinated repeat: "${transcript.slice(0, 80)}..."`);
      transcript = "";
    }

    console.log(`[STT] (${useGroq ? "groq" : "local"}) transcript: "${transcript}"`);
    return NextResponse.json({ transcript });
  } catch (err) {
    console.error("[STT] error:", (err as Error).message);
    return NextResponse.json(
      { transcript: "", error: "STT service unavailable" },
      { status: 503 }
    );
  }
}
