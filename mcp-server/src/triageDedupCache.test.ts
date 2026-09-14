import { describe, it, expect } from "vitest";
import { TriageJudgmentCache, buildTriageKey } from "./triageDedupCache.js";

const blockedA = [{ session_id: 82, blocking_session_id: 51, database_name: "Orders" }];
const blockedB = [{ session_id: 90, blocking_session_id: 51, database_name: "Orders" }];
const failedReportsA = [{ report_path: "/Sales/Quarterly", status: "Timeout", time_start: "2026-09-13T10:00:00Z" }];

describe("buildTriageKey", () => {
  it("produces the same key for the same evidence regardless of array order", () => {
    const rowX = { session_id: 1, blocking_session_id: 2, database_name: "Orders" };
    const rowY = { session_id: 3, blocking_session_id: 4, database_name: "Billing" };
    const keyForward = buildTriageKey([rowX, rowY], []);
    const keyReversed = buildTriageKey([rowY, rowX], []);
    expect(keyForward).toBe(keyReversed);
  });

  it("produces a different key when the evidence actually differs", () => {
    expect(buildTriageKey(blockedA, [])).not.toBe(buildTriageKey(blockedB, []));
  });

  it("incorporates both SQL and SSRS evidence into the key", () => {
    const sqlOnly = buildTriageKey(blockedA, []);
    const sqlAndSsrs = buildTriageKey(blockedA, failedReportsA);
    expect(sqlOnly).not.toBe(sqlAndSsrs);
  });
});

describe("TriageJudgmentCache", () => {
  it("returns a cached judgment for the exact same evidence key (happy path)", () => {
    const cache = new TriageJudgmentCache();
    const key = buildTriageKey(blockedA, []);
    cache.set(key, { judgmentText: "Session 82 is most urgent.", evidenceText: "SQL: ...", computedAt: 1_000 });

    const result = cache.get(key, 1_500);

    expect(result?.judgmentText).toBe("Session 82 is most urgent.");
  });

  it("misses for evidence that was never cached", () => {
    const cache = new TriageJudgmentCache();
    expect(cache.get(buildTriageKey(blockedA, []), 1_000)).toBeUndefined();
  });

  it("misses once the evidence changes, even though something is still cached", () => {
    const cache = new TriageJudgmentCache();
    cache.set(buildTriageKey(blockedA, []), { judgmentText: "old", evidenceText: "old", computedAt: 1_000 });

    const result = cache.get(buildTriageKey(blockedB, []), 1_100);

    expect(result).toBeUndefined();
  });

  it("expires an entry once the TTL has passed", () => {
    const cache = new TriageJudgmentCache(1_000); // 1s TTL for the test
    const key = buildTriageKey(blockedA, []);
    cache.set(key, { judgmentText: "old", evidenceText: "old", computedAt: 0 });

    expect(cache.get(key, 500)).toBeDefined(); // still within TTL
    expect(cache.get(key, 1_500)).toBeUndefined(); // past TTL
  });

  it("prunes expired entries so the cache doesn't grow unbounded", () => {
    const cache = new TriageJudgmentCache(1_000);
    cache.set(buildTriageKey(blockedA, []), { judgmentText: "a", evidenceText: "a", computedAt: 0 });
    cache.set(buildTriageKey(blockedB, []), { judgmentText: "b", evidenceText: "b", computedAt: 0 });

    cache.get(buildTriageKey(blockedA, []), 5_000); // any get() past the TTL prunes both

    expect(cache.size).toBe(0);
  });
});
