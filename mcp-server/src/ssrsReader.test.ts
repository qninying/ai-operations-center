import { describe, it, expect, vi, beforeEach } from "vitest";
import { readSsrsExecutionLog, UnsupportedSsrsQueryError } from "./ssrsReader.js";
import { executionLogFixture, SsrsExecutionLogRow } from "./ssrsFixtures.js";
import { SsrsLiveSourceUnavailableError } from "./ssrsLiveSource.js";
import { UpstreamCallFailedError } from "./reliability/withReliability.js";
import { CircuitOpenError } from "./reliability/circuitBreaker.js";
import { logEvent } from "./observability/logger.js";

vi.mock("./observability/logger.js", () => ({
  logEvent: vi.fn(),
}));

function makeRows(count: number): SsrsExecutionLogRow[] {
  return Array.from({ length: count }, (_, i) => ({
    instance_name: "SSRS01",
    report_path: "/Live/Report",
    user_name: "live-user",
    status: "rsInternalError",
    time_start: "2026-08-24T10:00:00Z",
    time_end: "2026-08-24T10:00:05Z",
    time_data_retrieval_ms: i,
    time_processing_ms: i,
    time_rendering_ms: i,
  }));
}

describe("readSsrsExecutionLog", () => {
  it("returns live rows tagged source: live on success (happy path)", async () => {
    const liveSource = vi.fn().mockResolvedValue(makeRows(2));
    const result = await readSsrsExecutionLog({ queryName: "ExecutionLog3" }, liveSource);
    expect(result.source).toBe("live");
    expect(result.rows).toHaveLength(2);
    expect(liveSource).toHaveBeenCalledOnce();
  });

  it("caps live results to 3 rows even if the source returns more (shaping)", async () => {
    const liveSource = vi.fn().mockResolvedValue(makeRows(7));
    const result = await readSsrsExecutionLog({ queryName: "ExecutionLog3" }, liveSource);
    expect(result.source).toBe("live");
    expect(result.rows).toHaveLength(3);
  });

  it("falls back to fixture data when the live source is unavailable", async () => {
    const liveSource = vi
      .fn()
      .mockRejectedValue(new SsrsLiveSourceUnavailableError(["SSRS_REPORTSERVER_DATABASE"]));
    const result = await readSsrsExecutionLog({ queryName: "ExecutionLog3" }, liveSource);
    expect(result.source).toBe("fallback");
    expect(result.rows).toEqual(executionLogFixture.slice(0, 3));
  });

  it("falls back to fixture data when the live query fails after retries are exhausted", async () => {
    const liveSource = vi.fn().mockRejectedValue(new UpstreamCallFailedError(4, new Error("timeout")));
    const result = await readSsrsExecutionLog({ queryName: "ExecutionLog3" }, liveSource);
    expect(result.source).toBe("fallback");
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it("falls back to fixture data when the circuit breaker is open", async () => {
    const liveSource = vi.fn().mockRejectedValue(new CircuitOpenError(30_000));
    const result = await readSsrsExecutionLog({ queryName: "ExecutionLog3" }, liveSource);
    expect(result.source).toBe("fallback");
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it("fallback still respects the reportPath filter", async () => {
    const liveSource = vi
      .fn()
      .mockRejectedValue(new SsrsLiveSourceUnavailableError(["SSRS_REPORTSERVER_DATABASE"]));
    const result = await readSsrsExecutionLog(
      { queryName: "ExecutionLog3", reportPath: "/Finance/MonthlyRevenue" },
      liveSource
    );
    expect(result.source).toBe("fallback");
    expect(result.rows.every((row) => row.report_path === "/Finance/MonthlyRevenue")).toBe(true);
  });

  it("does not swallow an unrecognized error from the live source (only known failures fall back)", async () => {
    const liveSource = vi.fn().mockRejectedValue(new Error("something unrelated broke"));
    await expect(readSsrsExecutionLog({ queryName: "ExecutionLog3" }, liveSource)).rejects.toThrow(
      "something unrelated broke"
    );
  });

  it("rejects with UnsupportedSsrsQueryError for an unsupported query name, without calling the live source (malformed input)", async () => {
    const liveSource = vi.fn();
    await expect(
      readSsrsExecutionLog({ queryName: "ExecutionLog9000" }, liveSource)
    ).rejects.toThrow(UnsupportedSsrsQueryError);
    expect(liveSource).not.toHaveBeenCalled();
  });
});

describe("readSsrsExecutionLog boundary cases: empty input and zero results", () => {
  beforeEach(() => {
    vi.mocked(logEvent).mockClear();
  });

  it("normalizes an empty-string reportPath filter to no filter, and logs a warn event", async () => {
    const liveSource = vi.fn().mockResolvedValue(makeRows(2));
    const result = await readSsrsExecutionLog(
      { queryName: "ExecutionLog3", reportPath: "" },
      liveSource
    );

    expect(result.rows).toHaveLength(2);
    expect(liveSource).toHaveBeenCalledWith({
      queryName: "ExecutionLog3",
      reportPath: undefined,
    });
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", event: "ssrs_empty_filter_normalized" })
    );
  });

  it("returns a friendly message and logs a warn event on genuinely empty live results", async () => {
    const liveSource = vi.fn().mockResolvedValue([]);
    const result = await readSsrsExecutionLog(
      { queryName: "ExecutionLog3", reportPath: "/No/Such/Report" },
      liveSource
    );

    expect(result.rows).toEqual([]);
    expect(result.message).toContain("/No/Such/Report");
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", event: "ssrs_zero_results" })
    );
  });

  it("returns a friendly message on zero results from the fallback path too", async () => {
    const liveSource = vi
      .fn()
      .mockRejectedValue(new SsrsLiveSourceUnavailableError(["SSRS_REPORTSERVER_DATABASE"]));
    const result = await readSsrsExecutionLog(
      { queryName: "ExecutionLog3", reportPath: "/No/Such/Report" },
      liveSource
    );

    expect(result.source).toBe("fallback");
    expect(result.rows).toEqual([]);
    expect(result.message).toBeDefined();
  });

  it("stays silent — no message, no warn log — when results are non-empty (happy path unaffected)", async () => {
    const liveSource = vi.fn().mockResolvedValue(makeRows(2));
    const result = await readSsrsExecutionLog({ queryName: "ExecutionLog3" }, liveSource);

    expect(result.message).toBeUndefined();
    expect(logEvent).not.toHaveBeenCalled();
  });
});
