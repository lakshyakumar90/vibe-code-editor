import { describe, it, expect } from "vitest";
import { RedisService } from "./redis.js";
import { CacheKeys, invalidateUserProjects, invalidateProject } from "./cache-keys.js";

describe("RedisService fallback", () => {
  it("returns null on get when Redis is unavailable", async () => {
    RedisService.__setUnavailable(true);
    expect(await RedisService.get("x")).toBeNull();
    // getOrSet still loads from source
    const v = await RedisService.getOrSet("x", 60, async () => 42);
    expect(v).toBe(42);
    RedisService.__setUnavailable(false);
  });

  it("set/delete/invalidate are safe no-ops when unavailable", async () => {
    RedisService.__setUnavailable(true);
    await RedisService.set("k", { a: 1 }, 60);
    await RedisService.delete("k");
    await RedisService.invalidate(["a*", "b"]);
    RedisService.__setUnavailable(false);
  });
});

describe("cache keys are user/project scoped", () => {
  it("keys differ per user and project", () => {
    expect(CacheKeys.userProjects("u1")).not.toBe(CacheKeys.userProjects("u2"));
    expect(CacheKeys.projectSummary("p1")).not.toBe(CacheKeys.projectSummary("p2"));
    expect(CacheKeys.githubRepos("u1", "h")).not.toBe(CacheKeys.githubRepos("u2", "h"));
  });

  it("invalidation helpers run without throwing", async () => {
    RedisService.__setUnavailable(true);
    await invalidateUserProjects("u1");
    await invalidateProject("p1", "u1");
    RedisService.__setUnavailable(false);
  });
});
