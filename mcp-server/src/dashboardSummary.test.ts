import { describe, it, expect } from "vitest";
import { buildDashboardSummary, UnknownRoleError } from "./dashboardSummary.js";
import type { DmvReadResult } from "./dmvReader.js";

function dmvResult(overrides: Partial<DmvReadResult> = {}): DmvReadResult {
  return {
    source: "live",
    rows: [
      { session_id: 52, status: "running", command: "SELECT", wait_type: null, blocking_session_id: 0, cpu_time_ms: 1200, total_elapsed_time_ms: 1450, database_name: "OpsWarehouse" },
      { session_id: 61, status: "suspended", command: "UPDATE", wait_type: "LCK_M_X", blocking_session_id: 52, cpu_time_ms: 40, total_elapsed_time_ms: 8600, database_name: "OpsWarehouse" },
      { session_id: 77, status: "runnable", command: "SELECT INTO", wait_type: "PAGEIOLATCH_SH", blocking_session_id: 0, cpu_time_ms: 300, total_elapsed_time_ms: 900, database_name: "StagingETL" },
    ],
    ...overrides,
  };
}

describe("buildDashboardSummary", () => {
  it("REQ-006/009: an IT Manager gets role-specific operational summary information, not raw rows", () => {
    const result = buildDashboardSummary("it-manager", dmvResult());

    expect(result).toEqual({
      role: "it-manager",
      incidentCount: 3,
      blockedSessionCount: 1,
      dataSource: "live",
    });
  });

  it("counts blocked sessions correctly (blocking_session_id > 0) and reports the real data source", () => {
    const result = buildDashboardSummary(
      "it-manager",
      dmvResult({ source: "fallback", rows: [
        { session_id: 1, status: "suspended", command: "UPDATE", wait_type: "LCK_M_X", blocking_session_id: 5, cpu_time_ms: 10, total_elapsed_time_ms: 20, database_name: "db" },
        { session_id: 2, status: "suspended", command: "UPDATE", wait_type: "LCK_M_X", blocking_session_id: 5, cpu_time_ms: 10, total_elapsed_time_ms: 20, database_name: "db" },
      ] })
    );

    expect(result.blockedSessionCount).toBe(2);
    expect(result.dataSource).toBe("fallback");
  });

  it("carries through the underlying zero-result message when present, rather than dropping it", () => {
    const result = buildDashboardSummary(
      "it-manager",
      dmvResult({ rows: [], message: "No active requests matched the filter." })
    );

    expect(result.incidentCount).toBe(0);
    expect(result.message).toBe("No active requests matched the filter.");
  });

  it("failure path — incorrect role information: throws UnknownRoleError for an unsupported role rather than rendering something wrong", () => {
    expect(() => buildDashboardSummary("dba", dmvResult())).toThrow(UnknownRoleError);
    expect(() => buildDashboardSummary("nonsense", dmvResult())).toThrow(UnknownRoleError);
  });

  it("failure path — incorrect role information: an empty role string is also rejected, not treated as a default", () => {
    expect(() => buildDashboardSummary("", dmvResult())).toThrow(UnknownRoleError);
  });
});
