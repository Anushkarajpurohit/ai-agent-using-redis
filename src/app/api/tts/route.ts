/**
 * POST /api/tts
 *
 * Accepts { text: string } JSON.
 * Uses msedge-tts (Microsoft Edge neural voices — free, no API key)
 * to synthesise audio and returns it as audio/mpeg bytes.
 *
 * Voice is controlled by the TTS_VOICE env var (default: en-US-JennyNeural).
 * Full voice list: https://speech.microsoft.com/portal/voicegallery
 */

import { NextRequest, NextResponse } from "next/server";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { Readable } from "stream";

const VOICE = process.env.TTS_VOICE ?? "en-US-JennyNeural";

export async function POST(req: NextRequest) {
  let text: string;
  try {
    ({ text } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!text?.trim()) {
    return NextResponse.json({ error: "Missing 'text' field" }, { status: 400 });
  }

  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);

    // msedge-tts v1.x: toStream() returns { audioStream: Readable, metadataStream: Readable|null }
    const { audioStream } = tts.toStream(text.trim()) as {
      audioStream: Readable;
      metadataStream: Readable | null;
    };

    const audioBuffer = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      audioStream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      audioStream.on("end", () => resolve(Buffer.concat(chunks)));
      audioStream.on("error", reject);
    });

    console.log(`[TTS] synthesised ${audioBuffer.length} bytes for: "${text.slice(0, 60)}"`);

    // NextResponse body must be BodyInit — convert Buffer to Uint8Array
    return new NextResponse(new Uint8Array(audioBuffer), {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(audioBuffer.length),
        "Cache-Control": "no-cache, no-store",
      },
    });
  } catch (err) {
    console.error("[TTS] error:", (err as Error).message);
    return NextResponse.json(
      { error: "TTS service unavailable — check internet connection" },
      { status: 503 }
    );
  }
}
