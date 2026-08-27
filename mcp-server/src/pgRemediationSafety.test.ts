import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { assessPostgresRemediation } from "./pgRemediationSafety.js";
import type { PgActivityRow } from "./pgActivitySource.js";

// Fixed clock so elapsed-time boundary tests (exactly 5 minutes) are
// deterministic, not subject to real wall-clock drift between constructing
// query_start and calling the function under test.
const NOW = new Date("2026-08-27T22:00:00.000Z").getTime();

function row(elapsedMs: number, overrides: Partial<PgActivityRow> = {}): PgActivityRow {
  return {
    pid: 4821,
    state: "active",
    query: "UPDATE orders SET status = 'shipped' WHERE id = 1;",
    query_start: new Date(NOW - elapsedMs).toISOString(),
    wait_event_type: "Lock",
    datname: "orders",
    backend_type: "client backend",
    blocked_by: [],
    ...overrides,
  };
}

describe("assessPostgresRemediation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("happy path: a routine, short, non-system, non-chained blocker is safe to terminate", () => {
    const rows = [row(8_600, { pid: 4821 })];
    expect(assessPostgresRemediation(4821, rows).safe).toBe(true);
  });

  it("system backend guard: a non-client backend_type is never safe", () => {
    const rows = [row(0, { pid: 12, backend_type: "autovacuum worker" })];
    const result = assessPostgresRemediation(12, rows);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("system process");
  });

  it("long-running guard: a blocker running longer than 5 minutes is not safe to terminate blind", () => {
    const rows = [row(1_920_000, { pid: 71 })]; // 32 min
    const result = assessPostgresRemediation(71, rows);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("32 minutes");
  });

  it("boundary: exactly 5 minutes (300_000ms) is still safe — the guard is strictly greater-than", () => {
    const rows = [row(300_000, { pid: 71 })];
    expect(assessPostgresRemediation(71, rows).safe).toBe(true);
  });

  it("boundary: one millisecond past 5 minutes is not safe", () => {
    const rows = [row(300_001, { pid: 71 })];
    expect(assessPostgresRemediation(71, rows).safe).toBe(false);
  });

  it("chained-blocker guard: a blocker that is itself blocked is not safe — the real cause is further up", () => {
    const rows = [
      row(9_800, { pid: 118, blocked_by: [95] }),
      row(15_000, { pid: 95, blocked_by: [] }),
    ];
    const result = assessPostgresRemediation(118, rows);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("backend 95");
  });

  it("the root of a chain, once reached, is independently assessed and can be safe", () => {
    const rows = [
      row(9_800, { pid: 118, blocked_by: [95] }),
      row(15_000, { pid: 95, blocked_by: [] }),
    ];
    expect(assessPostgresRemediation(95, rows).safe).toBe(true);
  });

  it("failure path: no evidence for the requested pid is not safe, not silently allowed", () => {
    const result = assessPostgresRemediation(999, [row(8_600, { pid: 4821 })]);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("No evidence");
  });

  it("is pure: identical input twice yields identical output, unmutated input", () => {
    const rows = [row(8_600, { pid: 4821 })];
    const snapshot = JSON.parse(JSON.stringify(rows));
    const first = assessPostgresRemediation(4821, rows);
    const second = assessPostgresRemediation(4821, rows);
    expect(first).toEqual(second);
    expect(rows).toEqual(snapshot);
  });
});
