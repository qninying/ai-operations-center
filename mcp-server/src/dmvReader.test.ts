import { describe, it, expect, vi, beforeEach } from "vitest";
import { readDmv, UnsupportedDmvError } from "./dmvReader.js";
import { dmExecRequestsFixture, DmvExecRequestRow } from "./dmvFixtures.js";
import { LiveSourceUnavailableError } from "./dmvLiveSource.js";
import { UpstreamCallFailedError } from "./reliability/withReliability.js";
import { CircuitOpenError } from "./reliability/circuitBreaker.js";
import { logEvent } from "./observability/logger.js";

vi.mock("./observability/logger.js", () => ({
  logEvent: vi.fn(),
}));

function makeRows(count: number): DmvExecRequestRow[] {
  return Array.from({ length: count }, (_, i) => ({
    session_id: 100 + i,
    status: "running",
    command: "SELECT",
    wait_type: null,
    blocking_session_id: 0,
    cpu_time_ms: i,
    total_elapsed_time_ms: i,
    database_name: "LiveDb",
  }));
}

describe("readDmv", () => {
  it("returns live rows tagged source: live on success (happy path)", async () => {
    const liveSource = vi.fn().mockResolvedValue(makeRows(2));
    const result = await readDmv({ dmvName: "sys.dm_exec_requests" }, liveSource);
    expect(result.source).toBe("live");
    expect(result.rows).toHaveLength(2);
    expect(liveSource).toHaveBeenCalledOnce();
  });

  it("caps live results to 3 rows even if the source returns more (shaping)", async () => {
    const liveSource = vi.fn().mockResolvedValue(makeRows(7));
    const result = await readDmv({ dmvName: "sys.dm_exec_requests" }, liveSource);
    expect(result.source).toBe("live");
    expect(result.rows).toHaveLength(3);
  });

  it("falls back to fixture data when the live source is unavailable", async () => {
    const liveSource = vi.fn().mockRejectedValue(new LiveSourceUnavailableError(["SQLSERVER_HOST"]));
    const result = await readDmv({ dmvName: "sys.dm_exec_requests" }, liveSource);
    expect(result.source).toBe("fallback");
    expect(result.rows).toEqual(dmExecRequestsFixture.slice(0, 3));
  });

  it("falls back to fixture data when the live query fails after retries are exhausted", async () => {
    const liveSource = vi.fn().mockRejectedValue(new UpstreamCallFailedError(4, new Error("timeout")));
    const result = await readDmv({ dmvName: "sys.dm_exec_requests" }, liveSource);
    expect(result.source).toBe("fallback");
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it("falls back to fixture data when the circuit breaker is open", async () => {
    const liveSource = vi.fn().mockRejectedValue(new CircuitOpenError(30_000));
    const result = await readDmv({ dmvName: "sys.dm_exec_requests" }, liveSource);
    expect(result.source).toBe("fallback");
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it("fallback still respects the databaseName filter", async () => {
    const liveSource = vi.fn().mockRejectedValue(new LiveSourceUnavailableError(["SQLSERVER_HOST"]));
    const result = await readDmv(
      { dmvName: "sys.dm_exec_requests", databaseName: "OpsWarehouse" },
      liveSource
    );
    expect(result.source).toBe("fallback");
    expect(result.rows.every((row) => row.database_name === "OpsWarehouse")).toBe(true);
  });

  it("does not swallow an unrecognized error from the live source (only known failures fall back)", async () => {
    const liveSource = vi.fn().mockRejectedValue(new Error("something unrelated broke"));
    await expect(readDmv({ dmvName: "sys.dm_exec_requests" }, liveSource)).rejects.toThrow(
      "something unrelated broke"
    );
  });

  it("rejects with UnsupportedDmvError for an unsupported DMV name, without calling the live source (malformed input)", async () => {
    const liveSource = vi.fn();
    await expect(
      readDmv({ dmvName: "sys.dm_bogus_view" }, liveSource)
    ).rejects.toThrow(UnsupportedDmvError);
    expect(liveSource).not.toHaveBeenCalled();
  });
});

describe("readDmv boundary cases: empty input and zero results", () => {
  beforeEach(() => {
    vi.mocked(logEvent).mockClear();
  });

  it("normalizes an empty-string databaseName filter to no filter, and logs a warn event", async () => {
    const liveSource = vi.fn().mockResolvedValue(makeRows(2));
    const result = await readDmv(
      { dmvName: "sys.dm_exec_requests", databaseName: "" },
      liveSource
    );

    expect(result.rows).toHaveLength(2);
    expect(liveSource).toHaveBeenCalledWith({
      dmvName: "sys.dm_exec_requests",
      databaseName: undefined,
    });
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", event: "dmv_empty_filter_normalized" })
    );
  });

  it("returns a friendly message and logs a warn event on genuinely empty live results", async () => {
    const liveSource = vi.fn().mockResolvedValue([]);
    const result = await readDmv(
      { dmvName: "sys.dm_exec_requests", databaseName: "NoSuchDb" },
      liveSource
    );

    expect(result.rows).toEqual([]);
    expect(result.message).toContain("NoSuchDb");
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", event: "dmv_zero_results" })
    );
  });

  it("returns a friendly message on zero results from the fallback path too", async () => {
    const liveSource = vi
      .fn()
      .mockRejectedValue(new LiveSourceUnavailableError(["SQLSERVER_HOST"]));
    const result = await readDmv(
      { dmvName: "sys.dm_exec_requests", databaseName: "NoSuchDatabase" },
      liveSource
    );

    expect(result.source).toBe("fallback");
    expect(result.rows).toEqual([]);
    expect(result.message).toBeDefined();
  });

  it("stays silent — no message, no warn log — when results are non-empty (happy path unaffected)", async () => {
    const liveSource = vi.fn().mockResolvedValue(makeRows(2));
    const result = await readDmv({ dmvName: "sys.dm_exec_requests" }, liveSource);

    expect(result.message).toBeUndefined();
    expect(logEvent).not.toHaveBeenCalled();
  });
});
