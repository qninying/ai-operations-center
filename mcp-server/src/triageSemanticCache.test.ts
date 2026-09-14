import { describe, it, expect, afterEach, vi } from "vitest";

// Same shared-mock-driven-by-a-queryImpl approach pgBackendStatusSource.test.ts
// already uses for its own pg.Pool calls, reused here for the same reason:
// fast, disk-free, no real Postgres needed to prove the query construction,
// threshold logic, and retry/release behavior are correct.
describe("triageSemanticCache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const CONFIG = { host: "localhost", port: 5435, database: "triage_vectors", user: "app", password: "app" };

  function mockPool(queryImpl: (sqlText: string, params: unknown[]) => Promise<unknown>) {
    const release = vi.fn();
    const query = vi.fn((sqlText: string, params: unknown[]) => queryImpl(sqlText, params));
    const connect = vi.fn().mockResolvedValue({ query, release });
    const Pool = vi.fn(function MockPool() {
      return { connect };
    });
    vi.doMock("pg", () => ({ default: { Pool } }));
    return { connect, query, release };
  }

  describe("findSemanticMatch", () => {
    it("happy path: a close-enough recent row is returned as a match", async () => {
      mockPool(async (sqlText) => {
        expect(sqlText).toContain("ORDER BY embedding <=> $1");
        return {
          rows: [
            {
              judgment_text: "Session 42 is the most urgent -- longest wait, active lock.",
              evidence_text: "SQL: session 42 blocked by session 10 on orders.",
              computed_at: "2026-09-14T12:00:00.000Z",
              distance: "0.031",
            },
          ],
        };
      });
      const { findSemanticMatch } = await import("./triageSemanticCache.js");

      const match = await findSemanticMatch(CONFIG, [0.1, 0.2, 0.3], 15 * 60 * 1000, Date.parse("2026-09-14T12:05:00.000Z"));

      expect(match).toMatchObject({
        judgmentText: "Session 42 is the most urgent -- longest wait, active lock.",
        distance: 0.031,
      });
    });

    it("a row exists but is not similar enough (distance above threshold) -- not treated as a match", async () => {
      mockPool(async () => ({
        rows: [{ judgment_text: "x", evidence_text: "y", computed_at: "2026-09-14T12:00:00.000Z", distance: "0.4" }],
      }));
      const { findSemanticMatch } = await import("./triageSemanticCache.js");

      const match = await findSemanticMatch(CONFIG, [0.1, 0.2, 0.3], 15 * 60 * 1000, Date.parse("2026-09-14T12:01:00.000Z"));

      expect(match).toBeNull();
    });

    it("no rows within the TTL window at all -- returns null, not an error", async () => {
      mockPool(async () => ({ rows: [] }));
      const { findSemanticMatch } = await import("./triageSemanticCache.js");

      const match = await findSemanticMatch(CONFIG, [0.1, 0.2, 0.3], 15 * 60 * 1000);

      expect(match).toBeNull();
    });

    it("passes the embedding as a bound [v,v,...] literal and the TTL cutoff as the second bound parameter", async () => {
      const { query } = mockPool(async () => ({ rows: [] }));
      const { findSemanticMatch } = await import("./triageSemanticCache.js");
      const now = Date.parse("2026-09-14T12:15:00.000Z");

      await findSemanticMatch(CONFIG, [0.5, -0.25, 1], 15 * 60 * 1000, now);

      const [sqlText, params] = query.mock.calls[0];
      expect(sqlText).not.toContain("0.5,-0.25,1");
      expect(params[0]).toBe("[0.5,-0.25,1]");
      expect(params[1]).toBe(new Date(now - 15 * 60 * 1000).toISOString());
    });

    it("failure path: query keeps failing -- rejects after the capped retries, releasing the client every attempt", async () => {
      vi.useFakeTimers();
      const { release } = mockPool(async () => {
        throw new Error("connection refused");
      });
      const { findSemanticMatch } = await import("./triageSemanticCache.js");

      const resultPromise = findSemanticMatch(CONFIG, [0.1, 0.2, 0.3], 15 * 60 * 1000);
      const assertion = expect(resultPromise).rejects.toThrow();
      // maxRetries: 1 -> 2 attempts total, each with its own TIMEOUT_MS(3s)
      // budget and a backoff gap between them.
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;

      expect(release).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });
  });

  describe("storeSemanticEntry", () => {
    it("happy path: inserts the embedding as a vector literal and runs the retention cleanup", async () => {
      const { query } = mockPool(async () => ({ rows: [] }));
      const { storeSemanticEntry } = await import("./triageSemanticCache.js");
      const computedAt = Date.parse("2026-09-14T12:00:00.000Z");

      await storeSemanticEntry(CONFIG, {
        cacheKey: "sql:42:10:orders",
        embedding: [0.1, 0.2],
        judgmentText: "Session 42 is most urgent.",
        evidenceText: "SQL: session 42 blocked by session 10 on orders.",
        computedAt,
      });

      expect(query).toHaveBeenCalledTimes(2);
      const [insertSql, insertParams] = query.mock.calls[0];
      expect(insertSql).toContain("INSERT INTO triage_judgments");
      expect(insertParams).toEqual([
        "sql:42:10:orders",
        "SQL: session 42 blocked by session 10 on orders.",
        "Session 42 is most urgent.",
        "[0.1,0.2]",
        new Date(computedAt).toISOString(),
      ]);
      const [deleteSql, deleteParams] = query.mock.calls[1];
      expect(deleteSql).toContain("DELETE FROM triage_judgments");
      expect(deleteParams).toEqual([new Date(computedAt - 24 * 60 * 60 * 1000).toISOString()]);
    });

    it("releases the client even when the insert fails", async () => {
      const { release } = mockPool(async () => {
        throw new Error("connection refused");
      });
      const { storeSemanticEntry } = await import("./triageSemanticCache.js");

      await expect(
        storeSemanticEntry(CONFIG, {
          cacheKey: "k",
          embedding: [0.1],
          judgmentText: "j",
          evidenceText: "e",
          computedAt: Date.now(),
        })
      ).rejects.toThrow();

      expect(release).toHaveBeenCalled();
    });
  });
});
