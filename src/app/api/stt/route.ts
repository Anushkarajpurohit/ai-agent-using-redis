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
    const transcript: string = data.text?.trim() ?? "";
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
