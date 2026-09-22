/**
 * Singleton Redis service. Graceful degradation: every method returns
 * null/no-op when REDIS_URL is unset or Redis is unavailable, so the app
 * falls back to DB/API (cache miss path) instead of breaking.
 * Never cache secrets/tokens — enforced by callers + key allowlist review.
 */
let client: any | null = null;
let unavailable = false;
let initAttempted = false;

async function getClient(): Promise<any | null> {
  const url = process.env.REDIS_URL;
  if (!url || unavailable) return null;
  if (client) return client;
  if (initAttempted) return client;
  initAttempted = true;
  try {
    const mod = await import("ioredis").catch(() => null as any);
    const Redis = (mod as any)?.default ?? (mod as any)?.Redis;
    if (!Redis) return null;
    const c = new Redis(url, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: true,
    });
    c.on("error", () => {
      unavailable = true;
    });
    await c.connect().catch(() => {
      unavailable = true;
      return null;
    });
    if (unavailable) return null;
    client = c;
    return client;
  } catch {
    unavailable = true;
    return null;
  }
}

export const RedisService = {
  async get<T = string>(key: string): Promise<T | null> {
    try {
      const c = await getClient();
      if (!c) return null;
      const v = await c.get(key);
      if (v === null || v === undefined) return null;
      try {
        return JSON.parse(v) as T;
      } catch {
        return v as unknown as T;
      }
    } catch {
      return null;
    }
  },
  async set(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
    try {
      const c = await getClient();
      if (!c) return;
      const v = typeof value === "string" ? value : JSON.stringify(value);
      if (ttlSeconds > 0) await c.set(key, v, "EX", ttlSeconds);
      else await c.set(key, v);
    } catch {
      // cache write failure is never fatal
    }
  },
  async delete(key: string): Promise<void> {
    try {
      const c = await getClient();
      if (!c) return;
      await c.del(key);
    } catch {
      // ignore
    }
  },
  async invalidate(patternOrKeys: string | string[]): Promise<void> {
    try {
      const c = await getClient();
      if (!c) return;
      const keys = Array.isArray(patternOrKeys) ? patternOrKeys : [patternOrKeys];
      for (const k of keys) {
        if (k.includes("*")) {
          // scan-based delete to avoid blocking KEYS
          let cursor = "0";
          do {
            const [next, found]: [string, string[]] = await c.scan(cursor, "MATCH", k, "COUNT", 100);
            cursor = next;
            if (found.length > 0) await c.del(...found);
          } while (cursor !== "0");
        } else {
          await c.del(k);
        }
      }
    } catch {
      // ignore
    }
  },
  async getOrSet<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== null) return hit;
    const fresh = await loader();
    await this.set(key, fresh, ttlSeconds);
    return fresh;
  },
  /** Test hook: force unavailable mode. */
  __setUnavailable(v: boolean) {
    unavailable = v;
    if (v) client = null;
    else initAttempted = false;
  },
};
