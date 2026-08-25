import { describe, it, expect, vi } from "vitest";
import {
  generateCorrelatedRecommendation,
  AllEvidenceSourcesUnavailableError,
  InvalidSsrsDataFormatError,
} from "./correlatedRecommendationService.js";
import { InvalidDataFormatError } from "./recommendationService.js";
import { LiveSourceUnavailableError } from "./dmvLiveSource.js";
import { SsrsLiveSourceUnavailableError } from "./ssrsLiveSource.js";
import type { RootCauseResult } from "./rootCauseAgent.js";
import { AuditLog } from "../../guardrails/auditLog.js";

const validDmvRow = {
  session_id: 61,
  status: "suspended",
  command: "UPDATE",
  wait_type: "LCK_M_X",
  blocking_session_id: 52,
  cpu_time_ms: 40,
  total_elapsed_time_ms: 8600,
  database_name: "OpsWarehouse",
};

const validSsrsRow = {
  instance_name: "SSRS01",
  report_path: "/Finance/MonthlyRevenue",
  user_name: "svc-report-runner",
  status: "rsProcessingAborted",
  time_start: "2026-08-24T08:12:03Z",
  time_end: "2026-08-24T08:22:03Z",
  time_data_retrieval_ms: 601000,
  time_processing_ms: 0,
  time_rendering_ms: 0,
};

function fakeRootCause(): RootCauseResult {
  return {
    rootCause: "Blocking chain on session 61 coincides with a stalled report render",
    confidence: 85,
    evidenceIdsUsed: ["sql:sys.dm_exec_requests:61:0", "ssrs:/Finance/MonthlyRevenue:2026-08-24T08:12:03Z:0"],
    insufficientEvidence: false,
  };
}

describe("generateCorrelatedRecommendation — REQ-017", () => {
  it("REQ-017: both sources reachable -> one analysis over combined evidence from both systems", async () => {
    const dmvQueryFn = vi.fn().mockResolvedValue([validDmvRow]);
    const ssrsQueryFn = vi.fn().mockResolvedValue([validSsrsRow]);
    const analyzeFn = vi.fn().mockResolvedValue(fakeRootCause());

    const result = await generateCorrelatedRecommendation("incident-1", "desc", {
      dmvQueryFn,
      ssrsQueryFn,
      analyzeFn,
    });

    expect(dmvQueryFn).toHaveBeenCalledWith({ dmvName: "sys.dm_exec_requests" });
    expect(ssrsQueryFn).toHaveBeenCalledWith({ queryName: "ExecutionLog3", reportPath: undefined });

    const incidentPassedToAgent = analyzeFn.mock.calls[0][0];
    expect(incidentPassedToAgent.evidence).toHaveLength(2);
    expect(incidentPassedToAgent.evidence.map((e: { source: string }) => e.source).sort()).toEqual(
      ["sys.dm_exec_requests", "ssrs-execution-log"].sort()
    );

    expect(result.partialCorrelation).toBe(false);
    expect(result.unavailableSources).toEqual([]);
    expect(result.rootCause).toBe(fakeRootCause().rootCause);
  });

  it("passes reportPath through to the SSRS query when given", async () => {
    const ssrsQueryFn = vi.fn().mockResolvedValue([validSsrsRow]);

    await generateCorrelatedRecommendation("incident-1b", "desc", {
      dmvQueryFn: vi.fn().mockResolvedValue([validDmvRow]),
      ssrsQueryFn,
      analyzeFn: vi.fn().mockResolvedValue(fakeRootCause()),
      reportPath: "/Finance/MonthlyRevenue",
    });

    expect(ssrsQueryFn).toHaveBeenCalledWith({ queryName: "ExecutionLog3", reportPath: "/Finance/MonthlyRevenue" });
  });

  it("partial — SQL Server unreachable, SSRS ok: still analyzes, flags the gap honestly", async () => {
    const analyzeFn = vi.fn().mockResolvedValue(fakeRootCause());

    const result = await generateCorrelatedRecommendation("incident-2", "desc", {
      dmvQueryFn: vi.fn().mockRejectedValue(new LiveSourceUnavailableError(["SQLSERVER_HOST"])),
      ssrsQueryFn: vi.fn().mockResolvedValue([validSsrsRow]),
      analyzeFn,
    });

    expect(analyzeFn).toHaveBeenCalled();
    const incidentPassedToAgent = analyzeFn.mock.calls[0][0];
    expect(incidentPassedToAgent.evidence).toHaveLength(1);
    expect(incidentPassedToAgent.evidence[0].source).toBe("ssrs-execution-log");
    expect(result.partialCorrelation).toBe(true);
    expect(result.unavailableSources).toEqual(["sql-server"]);
  });

  it("partial — SSRS unreachable, SQL Server ok: still analyzes, flags the gap honestly", async () => {
    const analyzeFn = vi.fn().mockResolvedValue(fakeRootCause());

    const result = await generateCorrelatedRecommendation("incident-3", "desc", {
      dmvQueryFn: vi.fn().mockResolvedValue([validDmvRow]),
      ssrsQueryFn: vi.fn().mockRejectedValue(new SsrsLiveSourceUnavailableError(["SSRS_REPORTSERVER_DATABASE"])),
      analyzeFn,
    });

    expect(analyzeFn).toHaveBeenCalled();
    const incidentPassedToAgent = analyzeFn.mock.calls[0][0];
    expect(incidentPassedToAgent.evidence).toHaveLength(1);
    expect(incidentPassedToAgent.evidence[0].source).toBe("sys.dm_exec_requests");
    expect(result.partialCorrelation).toBe(true);
    expect(result.unavailableSources).toEqual(["ssrs"]);
  });

  it("failure path — both sources unreachable: no fabricated fallback, no analysis attempted", async () => {
    const analyzeFn = vi.fn();

    await expect(
      generateCorrelatedRecommendation("incident-4", "desc", {
        dmvQueryFn: vi.fn().mockRejectedValue(new LiveSourceUnavailableError(["SQLSERVER_HOST"])),
        ssrsQueryFn: vi.fn().mockRejectedValue(new SsrsLiveSourceUnavailableError(["SSRS_REPORTSERVER_DATABASE"])),
        analyzeFn,
      })
    ).rejects.toThrow(AllEvidenceSourcesUnavailableError);

    expect(analyzeFn).not.toHaveBeenCalled();
  });

  it("failure path — malformed DMV row (SSRS ok): hard stop even though the other source succeeded", async () => {
    const malformedDmvRow = { ...validDmvRow, session_id: "not-a-number" };
    const analyzeFn = vi.fn();

    await expect(
      generateCorrelatedRecommendation("incident-5", "desc", {
        dmvQueryFn: vi.fn().mockResolvedValue([malformedDmvRow]),
        ssrsQueryFn: vi.fn().mockResolvedValue([validSsrsRow]),
        analyzeFn,
      })
    ).rejects.toThrow(InvalidDataFormatError);

    expect(analyzeFn).not.toHaveBeenCalled();
  });

  it("failure path — malformed SSRS row (SQL Server ok): hard stop even though the other source succeeded", async () => {
    const malformedSsrsRow = { ...validSsrsRow, time_data_retrieval_ms: "oops" };
    const analyzeFn = vi.fn();

    await expect(
      generateCorrelatedRecommendation("incident-6", "desc", {
        dmvQueryFn: vi.fn().mockResolvedValue([validDmvRow]),
        ssrsQueryFn: vi.fn().mockResolvedValue([malformedSsrsRow]),
        analyzeFn,
      })
    ).rejects.toThrow(InvalidSsrsDataFormatError);

    expect(analyzeFn).not.toHaveBeenCalled();
  });

  it("Trust — every access attempt is logged, one per source, even on a partial failure", async () => {
    const logger = await import("./observability/logger.js");
    const logSpy = vi.spyOn(logger, "logEvent");

    await generateCorrelatedRecommendation("incident-7", "desc", {
      dmvQueryFn: vi.fn().mockRejectedValue(new LiveSourceUnavailableError(["SQLSERVER_HOST"])),
      ssrsQueryFn: vi.fn().mockResolvedValue([validSsrsRow]),
      analyzeFn: vi.fn().mockResolvedValue(fakeRootCause()),
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "correlated_recommendation_data_access",
        context: expect.objectContaining({ source: "sql-server", outcome: "failure" }),
      })
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "correlated_recommendation_data_access",
        context: expect.objectContaining({ source: "ssrs", outcome: "success" }),
      })
    );
  });

  it("ADR-002: incidentId doubles as the correlation ID, with one audit entry per source", async () => {
    const auditLog = new AuditLog();

    await generateCorrelatedRecommendation("incident-8", "desc", {
      dmvQueryFn: vi.fn().mockResolvedValue([validDmvRow]),
      ssrsQueryFn: vi.fn().mockResolvedValue([validSsrsRow]),
      analyzeFn: vi.fn().mockResolvedValue(fakeRootCause()),
      auditLog,
    });

    const entries = auditLog.forCorrelationId("incident-8");
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.entryType === "system_event" && e.outcome === "success")).toBe(true);
    expect(entries.map((e) => (e.entryType === "system_event" ? e.context.source : undefined)).sort()).toEqual(
      ["sql-server", "ssrs"].sort()
    );

    await generateCorrelatedRecommendation("incident-9", "desc", {
      dmvQueryFn: vi.fn().mockRejectedValue(new LiveSourceUnavailableError(["SQLSERVER_HOST"])),
      ssrsQueryFn: vi.fn().mockRejectedValue(new SsrsLiveSourceUnavailableError(["SSRS_REPORTSERVER_DATABASE"])),
      analyzeFn: vi.fn(),
      auditLog,
    }).catch(() => {});

    const failureEntries = auditLog.forCorrelationId("incident-9");
    expect(failureEntries).toHaveLength(2);
    expect(failureEntries.every((e) => e.outcome === "failure")).toBe(true);
  });
});
