/**
 * Telephony bridge — connects Asterisk's AudioSocket dialplan app to the
 * same STT → orchestrator → TTS pipeline the browser UI uses
 * (see src/components/ChatVoiceUI.tsx). One TCP connection = one call.
 *
 * Run standalone: tsx src/telephony/bridge.ts
 * Dialplan side:  AudioSocket(${UUID},host.docker.internal:9099)
 *
 * AudioSocket wire format: 3-byte header (1 byte type + 2-byte BE length)
 * followed by `length` bytes of payload.
 *   0x00 = hangup/terminate (empty payload)
 *   0x01 = call UUID (16-byte payload, sent once at connection start)
 *   0x10 = audio (raw 8kHz/16-bit signed LE mono PCM)
 */

import net from "node:net";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

const PORT = Number(process.env.TELEPHONY_BRIDGE_PORT ?? 9099);
const BASE_URL = process.env.NEXT_BASE_URL ?? "http://localhost:3000";

const GREETING =
  "Hi, I'm Maya. What symptoms are you having, or who would you like to see today?";

// Telephony audio is 8kHz/16-bit mono: 320 bytes = 20ms frame.
const SAMPLE_RATE = 8000;
const FRAME_BYTES = 320;
const FRAME_MS = 20;

// Same silence-detection scale as ChatVoiceUI.tsx's getRmsLevel (amplitude 0-100).
const SILENCE_RMS_THRESHOLD = 8;
const SILENCE_DURATION_MS = 1800;
const MAX_UTTERANCE_MS = 30_000;
const MIN_UTTERANCE_MS = 300; // ignore near-empty blips right after TTS ends

const FRAME_TYPE = { HANGUP: 0x00, UUID: 0x01, AUDIO: 0x10 } as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function formatUuid(buf: Buffer): string {
  const hex = buf.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function rmsOfPcm16(payload: Buffer): number {
  const samples = payload.length / 2;
  if (samples === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const v = payload.readInt16LE(i * 2) / 32768;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / samples) * 100;
}

function pcmToWav(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function mp3ToPcm8k(mp3: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("ffmpeg-static binary not found"));
    const proc = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-f",
      "s16le",
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      "1",
      "pipe:1",
    ]);
    const chunks: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
    });
    proc.stdin.end(mp3);
  });
}

async function synthesize(text: string): Promise<Buffer> {
  const res = await fetch(`${BASE_URL}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}`);
  const mp3 = Buffer.from(await res.arrayBuffer());
  return mp3ToPcm8k(mp3);
}

async function transcribe(wav: Buffer): Promise<string> {
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "call.wav");
  const res = await fetch(`${BASE_URL}/api/stt`, { method: "POST", body: form });
  const data = await res.json();
  return (data.transcript ?? "").trim();
}

async function chat(sessionId: string, message: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, message }),
  });
  const data = await res.json();
  if (data.error) return data.error as string;
  return data.reply as string;
}

interface CallSession {
  socket: net.Socket;
  callId: string;
  buffer: Buffer; // raw AudioSocket frame accumulator
  utterance: Buffer[];
  silentMs: number;
  utteranceMs: number;
  state: "greeting" | "listening" | "thinking" | "speaking";
  hungUp: boolean;
}

async function sendPcmFrames(session: CallSession, pcm: Buffer): Promise<void> {
  for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
    if (session.hungUp || session.socket.destroyed) return;
    let chunk = pcm.subarray(offset, offset + FRAME_BYTES);
    if (chunk.length < FRAME_BYTES) {
      const padded = Buffer.alloc(FRAME_BYTES);
      chunk.copy(padded);
      chunk = padded;
    }
    const frame = Buffer.alloc(3 + FRAME_BYTES);
    frame[0] = FRAME_TYPE.AUDIO;
    frame.writeUInt16BE(FRAME_BYTES, 1);
    chunk.copy(frame, 3);
    session.socket.write(frame);
    await sleep(FRAME_MS);
  }
}

async function speak(session: CallSession, text: string): Promise<void> {
  session.state = "speaking";
  try {
    const pcm = await synthesize(text);
    await sendPcmFrames(session, pcm);
  } catch (err) {
    console.error(`[telephony ${session.callId}] TTS/playback error:`, err);
  }
  if (!session.hungUp) {
    session.state = "listening";
    session.silentMs = 0;
    session.utteranceMs = 0;
    session.utterance = [];
  }
}

async function handleUtterance(session: CallSession): Promise<void> {
  const pcm = Buffer.concat(session.utterance);
  session.utterance = [];
  session.silentMs = 0;
  session.utteranceMs = 0;

  if (pcm.length < (MIN_UTTERANCE_MS / 1000) * SAMPLE_RATE * 2) {
    session.state = "listening";
    return;
  }

  session.state = "thinking";
  try {
    const transcript = await transcribe(pcmToWav(pcm));
    console.log(`[telephony ${session.callId}] transcript: "${transcript}"`);
    if (!transcript) {
      session.state = "listening";
      return;
    }
    const reply = await chat(session.callId, transcript);
    console.log(`[telephony ${session.callId}] reply: "${reply}"`);
    await speak(session, reply);
  } catch (err) {
    console.error(`[telephony ${session.callId}] turn error:`, err);
    if (!session.hungUp) {
      await speak(session, "Sorry, I lost connection for a moment. Could you say that again?");
    }
  }
}

function handleAudioFrame(session: CallSession, payload: Buffer) {
  if (session.state !== "listening") return; // drop caller audio while greeting/speaking/thinking

  session.utterance.push(payload);
  session.utteranceMs += FRAME_MS;

  const rms = rmsOfPcm16(payload);
  if (rms < SILENCE_RMS_THRESHOLD) {
    session.silentMs += FRAME_MS;
  } else {
    session.silentMs = 0;
  }

  if (
    (session.silentMs >= SILENCE_DURATION_MS && session.utteranceMs >= MIN_UTTERANCE_MS) ||
    session.utteranceMs >= MAX_UTTERANCE_MS
  ) {
    void handleUtterance(session);
  }
}

function processFrames(session: CallSession) {
  while (session.buffer.length >= 3) {
    const type = session.buffer[0];
    const length = session.buffer.readUInt16BE(1);
    if (session.buffer.length < 3 + length) break; // wait for more data

    const payload = session.buffer.subarray(3, 3 + length);
    session.buffer = session.buffer.subarray(3 + length);

    switch (type) {
      case FRAME_TYPE.UUID:
        session.callId = formatUuid(payload);
        console.log(`[telephony] call started: ${session.callId}`);
        void speak(session, GREETING);
        break;
      case FRAME_TYPE.AUDIO:
        handleAudioFrame(session, payload);
        break;
      case FRAME_TYPE.HANGUP:
        session.hungUp = true;
        session.socket.end();
        break;
      default:
        // Unhandled frame types (e.g. DTMF, error) are ignored.
        break;
    }
  }
}

const server = net.createServer((socket) => {
  const session: CallSession = {
    socket,
    callId: `telephony-${Date.now()}`, // replaced once the UUID frame arrives
    buffer: Buffer.alloc(0),
    utterance: [],
    silentMs: 0,
    utteranceMs: 0,
    state: "greeting",
    hungUp: false,
  };

  socket.on("data", (chunk: Buffer) => {
    session.buffer = Buffer.concat([session.buffer, chunk]);
    processFrames(session);
  });

  socket.on("close", () => {
    session.hungUp = true;
    console.log(`[telephony ${session.callId}] call ended`);
  });

  socket.on("error", (err) => {
    session.hungUp = true;
    console.error(`[telephony ${session.callId}] socket error:`, err.message);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[telephony] AudioSocket bridge listening on 0.0.0.0:${PORT} (Next server: ${BASE_URL})`);
});
