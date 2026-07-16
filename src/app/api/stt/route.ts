/**
 * POST /api/stt
 *
 * Accepts a multipart/form-data request with an "audio" blob (WebM/Ogg),
 * proxies it to the local faster-whisper-server (OpenAI-compatible endpoint),
 * and returns { transcript: string }.
 *
 * Sidecar: docker run -d --name whisper-server -p 8000:8000 \
 *   -e WHISPER__MODEL=base.en \
 *   fedirz/faster-whisper-server:latest-cpu
 */

import { NextRequest, NextResponse } from "next/server";

const WHISPER_URL =
  process.env.WHISPER_URL || "http://localhost:8000/v1/audio/transcriptions";

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

  // Build a fresh FormData to forward to whisper server
  const whisperForm = new FormData();
  whisperForm.append("file", audio, "audio.webm");
  // "model" field is required by the OpenAI API shape — whisper server ignores it
  // and uses whatever model it was started with, but the field must be present.
  whisperForm.append("model", "whisper-1");
  whisperForm.append("language", process.env.WHISPER_LANGUAGE ?? "en");
  whisperForm.append("response_format", "json");

  try {
    const res = await fetch(WHISPER_URL, {
      method: "POST",
      body: whisperForm,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[STT] whisper server ${res.status}: ${body}`);
      throw new Error(`Whisper server returned ${res.status}`);
    }

    const data = await res.json();
    let transcript: string = data.text?.trim() ?? "";

    if (transcript && isHallucinatedRepeat(transcript)) {
      console.warn(`[STT] discarding likely hallucinated repeat: "${transcript.slice(0, 80)}..."`);
      transcript = "";
    }

    console.log(`[STT] transcript: "${transcript}"`);
    return NextResponse.json({ transcript });
  } catch (err) {
    console.error("[STT] error:", (err as Error).message);
    return NextResponse.json(
      { transcript: "", error: "STT service unavailable — is the whisper Docker container running?" },
      { status: 503 }
    );
  }
}
