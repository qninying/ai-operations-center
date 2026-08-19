import { describe, it, expect, vi } from "vitest";
import {
  generateRecommendation,
  SqlServerUnavailableError,
  InvalidDataFormatError,
} from "./recommendationService.js";
import { LiveSourceUnavailableError } from "./dmvLiveSource.js";
import type { RootCauseResult } from "./rootCauseAgent.js";

const validRow = {
  session_id: 61,
  status: "suspended",
  command: "UPDATE",
  wait_type: "LCK_M_X",
  blocking_session_id: 52,
  cpu_time_ms: 40,
  total_elapsed_time_ms: 8600,
  database_name: "OpsWarehouse",
};

function fakeRootCause(): RootCauseResult {
  return {
    rootCause: "Blocking chain on session 61",
    confidence: 85,
    evidenceIdsUsed: ["sql:sys.dm_exec_requests:61:0"],
    insufficientEvidence: false,
  };
}

describe("generateRecommendation", () => {
  it("REQ-007/013: connected to SQL Server -> a real AI recommendation using real SQL Server data", async () => {
    const queryFn = vi.fn().mockResolvedValue([validRow]);
    const analyzeFn = vi.fn().mockResolvedValue(fakeRootCause());

    const result = await generateRecommendation("incident-1", "Session 61 blocked", {
      queryFn,
      analyzeFn,
    });

    expect(result.rootCause).toBe("Blocking chain on session 61");
    expect(queryFn).toHaveBeenCalledWith({ dmvName: "sys.dm_exec_requests" });

    const incidentPassedToAgent = analyzeFn.mock.calls[0][0];
    expect(incidentPassedToAgent.evidence[0].data).toEqual(validRow);
    expect(incidentPassedToAgent.evidence[0].source).toBe("sys.dm_exec_requests");
  });

  it("failure path — connection failure: unreachable SQL Server never falls back to fixture data, notifies instead", async () => {
    const queryFn = vi.fn().mockRejectedValue(new LiveSourceUnavailableError(["SQLSERVER_HOST"]));
    const analyzeFn = vi.fn();

    await expect(
      generateRecommendation("incident-2", "desc", { queryFn, analyzeFn })
    ).rejects.toThrow(SqlServerUnavailableError);

    expect(analyzeFn).not.toHaveBeenCalled();
  });

  it("failure path — data retrieval timeout: also surfaces as SqlServerUnavailableError, not a silent hang or fake result", async () => {
    const queryFn = vi.fn().mockRejectedValue(new Error("upstream call timed out"));

    await expect(
      generateRecommendation("incident-3", "desc", { queryFn, analyzeFn: vi.fn() })
    ).rejects.toThrow(SqlServerUnavailableError);
  });

  it("failure path — invalid data format: a malformed row is rejected, not silently passed through as evidence", async () => {
    const malformedRow = { ...validRow, session_id: "not-a-number" };
    const queryFn = vi.fn().mockResolvedValue([malformedRow]);
    const analyzeFn = vi.fn();

    await expect(
      generateRecommendation("incident-4", "desc", { queryFn, analyzeFn })
    ).rejects.toThrow(InvalidDataFormatError);

    expect(analyzeFn).not.toHaveBeenCalled();
  });

  it("Trust — every access attempt is logged, including the invalid-data-format failure path", async () => {
    const logger = await import("./observability/logger.js");
    const logSpy = vi.spyOn(logger, "logEvent");

    const malformedRow = { ...validRow, blocking_session_id: "oops" };
    await generateRecommendation("incident-5", "desc", {
      queryFn: vi.fn().mockResolvedValue([malformedRow]),
      analyzeFn: vi.fn(),
    }).catch(() => {});

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "recommendation_data_access",
        context: expect.objectContaining({ outcome: "failure", errorClass: "InvalidDataFormatError" }),
      })
    );
  });
});
