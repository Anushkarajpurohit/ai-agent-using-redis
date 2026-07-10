import { cacheGet, cacheSet, CacheKeys } from "../lib/cache";
import { ConversationSession } from "./types";

const TTL_SESSION = parseInt(process.env.CACHE_TTL_SESSION || "1800", 10);

export async function loadSession(sessionId: string): Promise<ConversationSession> {
  const key = CacheKeys.session(sessionId);
  const existing = await cacheGet<ConversationSession>(key);
  if (existing) return existing;

  const fresh: ConversationSession = {
    sessionId,
    goal: "none",
    stage: "greeting",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await cacheSet(key, fresh, TTL_SESSION);
  return fresh;
}

export async function saveSession(session: ConversationSession): Promise<void> {
  session.updatedAt = new Date().toISOString();
  await cacheSet(CacheKeys.session(session.sessionId), session, TTL_SESSION);
}
