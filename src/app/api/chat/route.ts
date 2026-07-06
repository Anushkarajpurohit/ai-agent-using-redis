import { NextRequest, NextResponse } from "next/server";
import { handleTurn } from "../../../agent/orchestrator";

export async function POST(req: NextRequest) {
  const start = Date.now();
  try {
    const body = await req.json();
    const { sessionId, message } = body as { sessionId?: string; message?: string };

    if (!sessionId || !message) {
      return NextResponse.json(
        { error: "sessionId and message are required" },
        { status: 400 }
      );
    }

    const result = await handleTurn(sessionId, message);

    const latencyMs = Date.now() - start;
    console.log(`[API /chat] session=${sessionId} latency=${latencyMs}ms stage=${result.stage}`);

    return NextResponse.json({ ...result, latencyMs });
  } catch (err) {
    console.error("[API /chat] error:", err);
    return NextResponse.json(
      { error: "Something went wrong processing that request." },
      { status: 500 }
    );
  }
}
