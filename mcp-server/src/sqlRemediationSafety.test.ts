import { describe, it, expect } from "vitest";
import { assessBlockingSessionRemediation } from "./sqlRemediationSafety.js";
import type { DmvExecRequestRow } from "./dmvFixtures.js";

function row(overrides: Partial<DmvExecRequestRow> = {}): DmvExecRequestRow {
  return {
    session_id: 61,
    status: "suspended",
    command: "UPDATE",
    wait_type: "LCK_M_X",
    blocking_session_id: 0,
    cpu_time_ms: 40,
    total_elapsed_time_ms: 8600,
    database_name: "OpsWarehouse",
    ...overrides,
  };
}

describe("assessBlockingSessionRemediation", () => {
  it("happy path: a routine, short, non-system, non-chained blocker is safe to kill", () => {
    const rows = [row({ session_id: 52 })];
    const result = assessBlockingSessionRemediation(52, rows);
    expect(result.safe).toBe(true);
  });

  it("system session guard: a blocker with session_id <= 50 is never safe", () => {
    const rows = [row({ session_id: 6, total_elapsed_time_ms: 0 })];
    const result = assessBlockingSessionRemediation(6, rows);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("system session");
  });

  it("boundary: session_id exactly 50 is still a system session (never safe)", () => {
    const rows = [row({ session_id: 50, total_elapsed_time_ms: 0 })];
    expect(assessBlockingSessionRemediation(50, rows).safe).toBe(false);
  });

  it("boundary: session_id 51 is a real user session, not a system session", () => {
    const rows = [row({ session_id: 51, total_elapsed_time_ms: 100 })];
    expect(assessBlockingSessionRemediation(51, rows).safe).toBe(true);
  });

  it("long-running guard: a blocker running longer than 5 minutes is not safe to kill blind", () => {
    const rows = [row({ session_id: 71, total_elapsed_time_ms: 1_920_000 })]; // 32 min
    const result = assessBlockingSessionRemediation(71, rows);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("32 minutes");
  });

  it("boundary: exactly 5 minutes (300_000ms) is still safe — the guard is strictly greater-than", () => {
    const rows = [row({ session_id: 71, total_elapsed_time_ms: 300_000 })];
    expect(assessBlockingSessionRemediation(71, rows).safe).toBe(true);
  });

  it("boundary: one millisecond past 5 minutes is not safe", () => {
    const rows = [row({ session_id: 71, total_elapsed_time_ms: 300_001 })];
    expect(assessBlockingSessionRemediation(71, rows).safe).toBe(false);
  });

  it("chained-blocker guard: a blocker that is itself blocked is not safe — the real cause is further up", () => {
    const rows = [
      row({ session_id: 118, blocking_session_id: 95, total_elapsed_time_ms: 9800 }),
      row({ session_id: 95, blocking_session_id: 0, total_elapsed_time_ms: 15000 }),
    ];
    const result = assessBlockingSessionRemediation(118, rows);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("session 95");
  });

  it("the root of a chain, once reached, is independently assessed and can be safe", () => {
    const rows = [
      row({ session_id: 118, blocking_session_id: 95, total_elapsed_time_ms: 9800 }),
      row({ session_id: 95, blocking_session_id: 0, total_elapsed_time_ms: 15000 }),
    ];
    // Session 95 itself has no upstream blocker and a short hold time — safe.
    expect(assessBlockingSessionRemediation(95, rows).safe).toBe(true);
  });

  it("failure path: no evidence for the requested session is not safe, not silently allowed", () => {
    const result = assessBlockingSessionRemediation(999, [row({ session_id: 52 })]);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("No evidence");
  });

  it("is pure: identical input twice yields identical output, unmutated input", () => {
    const rows = [row({ session_id: 52 })];
    const snapshot = JSON.parse(JSON.stringify(rows));
    const first = assessBlockingSessionRemediation(52, rows);
    const second = assessBlockingSessionRemediation(52, rows);
    expect(first).toEqual(second);
    expect(rows).toEqual(snapshot);
  });
});
