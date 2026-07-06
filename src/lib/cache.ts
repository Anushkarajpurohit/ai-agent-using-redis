import Redis from "ioredis";

/**
 * Unified cache layer.
 *
 * - Tries Redis first (if REDIS_URL is set and reachable).
 * - Falls back to an in-process Map if Redis is unavailable, so the app
 *   never hard-fails on caching — it just gets slower / single-instance.
 * - Every get/set/miss is console-logged with a [CACHE] prefix so latency
 *   behavior is visible during development and demos.
 */

type CacheEntry = { value: string; expiresAt: number };

const memoryStore = new Map<string, CacheEntry>();

let redisClient: Redis | null = null;
let redisReady = false;

function getRedis(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  if (redisClient) return redisClient;

  redisClient = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null, // don't hammer retries; just fall back
  });

  redisClient.on("error", (err) => {
    if (redisReady) {
      console.warn("[CACHE] Redis error, falling back to in-memory:", err.message);
    }
    redisReady = false;
  });

  redisClient.on("ready", () => {
    redisReady = true;
    console.log("[CACHE] Redis connected — using Redis as primary cache");
  });

  redisClient.connect().catch(() => {
    redisReady = false;
    console.warn("[CACHE] Redis unreachable at startup — using in-memory cache");
  });

  return redisClient;
}

function memoryGet(key: string): string | null {
  const entry = memoryStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memoryStore.delete(key);
    return null;
  }
  return entry.value;
}

function memorySet(key: string, value: string, ttlSeconds: number) {
  memoryStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const redis = getRedis();
  if (redis && redisReady) {
    try {
      const raw = await redis.get(key);
      if (raw) {
        console.log(`[CACHE HIT] (redis) ${key}`);
        return JSON.parse(raw) as T;
      }
      console.log(`[CACHE MISS] (redis) ${key}`);
      return null;
    } catch (err) {
      console.warn(`[CACHE] redis.get failed for ${key}, falling back to memory`, err);
    }
  }

  const raw = memoryGet(key);
  if (raw) {
    console.log(`[CACHE HIT] (memory) ${key}`);
    return JSON.parse(raw) as T;
  }
  console.log(`[CACHE MISS] (memory) ${key}`);
  return null;
}

export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds: number
): Promise<void> {
  const serialized = JSON.stringify(value);
  const redis = getRedis();
  if (redis && redisReady) {
    try {
      await redis.set(key, serialized, "EX", ttlSeconds);
      console.log(`[CACHE SET] (redis) ${key} ttl=${ttlSeconds}s`);
      return;
    } catch (err) {
      console.warn(`[CACHE] redis.set failed for ${key}, writing to memory instead`, err);
    }
  }
  memorySet(key, serialized, ttlSeconds);
  console.log(`[CACHE SET] (memory) ${key} ttl=${ttlSeconds}s`);
}

export async function cacheDel(key: string): Promise<void> {
  const redis = getRedis();
  if (redis && redisReady) {
    try {
      await redis.del(key);
    } catch {
      /* ignore, memory del below still runs */
    }
  }
  memoryStore.delete(key);
  console.log(`[CACHE DEL] ${key}`);
}

// ---------------------------------------------------------------------------
// Cache key builders — centralized so orchestrator/queries never hand-roll
// key strings that could drift out of sync.
// ---------------------------------------------------------------------------
export const CacheKeys = {
  doctorsBySpecialization: (specialization: string) =>
    `doctors:spec:${specialization.toLowerCase()}`,
  doctorSlots7Day: (doctorId: number, fromDate: string) =>
    `slots:doctor:${doctorId}:from:${fromDate}`,
  session: (sessionId: string) => `session:${sessionId}`,
};
