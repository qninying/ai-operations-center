import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

const ENV_KEYS = ["SQLSERVER_HOST", "SSRS_REPORTSERVER_DATABASE", "SQLSERVER_USER", "SQLSERVER_PASSWORD"];

function clearSsrsEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function setSsrsEnv() {
  process.env.SQLSERVER_HOST = "test-host";
  process.env.SSRS_REPORTSERVER_DATABASE = "ReportServer";
  process.env.SQLSERVER_USER = "test-user";
  process.env.SQLSERVER_PASSWORD = "test-password";
}

// Registers a mocked mssql module and returns its spies, mirroring dmvLiveSource.test.ts's
// mockMssql() exactly. Must be called before the dynamic import of ssrsLiveSource.js.
function mockMssql(query: ReturnType<typeof vi.fn>) {
  const connect = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  const input = vi.fn();
  const request = vi.fn(() => ({ input, query }));

  vi.doMock("mssql", () => ({
    default: {
      ConnectionPool: vi.fn(function MockConnectionPool() {
        return { connect, close, request };
      }),
      NVarChar: "NVarChar",
    },
  }));

  return { connect, close, input, request };
}

// Same R5-derived reliability spec as dmvLiveSource.ts: 10s timeout, 3 retries (4
// attempts total), exponential backoff, and a circuit breaker opening after 5
// accumulated failures within a 60s window. Fake timers throughout for the same
// reason as dmvLiveSource.test.ts.
describe("querySsrsExecutionLog", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("throws SsrsLiveSourceUnavailableError listing every missing env var, without attempting a connection", async () => {
    clearSsrsEnv();
    const { querySsrsExecutionLog, SsrsLiveSourceUnavailableError } = await import("./ssrsLiveSource.js");

    await expect(querySsrsExecutionLog({ queryName: "ExecutionLog3" })).rejects.toThrow(
      SsrsLiveSourceUnavailableError
    );
  });

  it("retries 3 times (4 attempts total) with backoff, then throws UpstreamCallFailedError", async () => {
    setSsrsEnv();
    const query = vi.fn().mockRejectedValue(new Error("connection reset"));
    const { connect } = mockMssql(query);

    const { querySsrsExecutionLog } = await import("./ssrsLiveSource.js");
    const { UpstreamCallFailedError } = await import("./reliability/withReliability.js");

    const resultPromise = querySsrsExecutionLog({ queryName: "ExecutionLog3" });
    const assertion = expect(resultPromise).rejects.toThrow(UpstreamCallFailedError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(connect).toHaveBeenCalledTimes(4);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("succeeds on a later retry without exhausting all attempts", async () => {
    setSsrsEnv();
    const rows = [{ instance_name: "SSRS01" }];
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({ recordset: rows });
    mockMssql(query);

    const { querySsrsExecutionLog } = await import("./ssrsLiveSource.js");

    const resultPromise = querySsrsExecutionLog({ queryName: "ExecutionLog3" });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(resultPromise).resolves.toEqual(rows);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("parameterizes reportPath via a bound input rather than concatenating it into the query text", async () => {
    setSsrsEnv();
    const injectionAttempt = "Sneaky'; DROP TABLE dbo.Users; --";
    const query = vi.fn().mockResolvedValue({ recordset: [] });
    const { input } = mockMssql(query);

    const { querySsrsExecutionLog } = await import("./ssrsLiveSource.js");
    await querySsrsExecutionLog({ queryName: "ExecutionLog3", reportPath: injectionAttempt });

    expect(input).toHaveBeenCalledWith("reportPath", "NVarChar", injectionAttempt);
    const queryText = query.mock.calls[0][0] as string;
    expect(queryText).not.toContain(injectionAttempt);
    expect(queryText).toContain("@reportPath");
  });

  it("excludes successful executions and orders by most recent first", async () => {
    setSsrsEnv();
    const query = vi.fn().mockResolvedValue({ recordset: [] });
    mockMssql(query);

    const { querySsrsExecutionLog } = await import("./ssrsLiveSource.js");
    await querySsrsExecutionLog({ queryName: "ExecutionLog3" });

    const queryText = query.mock.calls[0][0] as string;
    expect(queryText).toContain("Status <> 'rsSuccess'");
    expect(queryText).toContain("ORDER BY TimeStart DESC");
  });

  it("opens the circuit breaker once failures cross the threshold, then fails fast without attempting a connection", async () => {
    setSsrsEnv();
    const query = vi.fn().mockRejectedValue(new Error("down"));
    const { connect } = mockMssql(query);

    const { querySsrsExecutionLog } = await import("./ssrsLiveSource.js");
    const { CircuitOpenError } = await import("./reliability/circuitBreaker.js");

    const call1 = querySsrsExecutionLog({ queryName: "ExecutionLog3" });
    const call1Assertion = expect(call1).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await call1Assertion;

    const call2 = querySsrsExecutionLog({ queryName: "ExecutionLog3" });
    const call2Assertion = expect(call2).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await call2Assertion;

    connect.mockClear();
    query.mockClear();

    await expect(querySsrsExecutionLog({ queryName: "ExecutionLog3" })).rejects.toThrow(
      CircuitOpenError
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("allows a half-open trial call after the cooldown elapses, and closes again on success", async () => {
    setSsrsEnv();
    const query = vi.fn().mockRejectedValue(new Error("down"));
    mockMssql(query);

    const { querySsrsExecutionLog } = await import("./ssrsLiveSource.js");
    const { CircuitOpenError } = await import("./reliability/circuitBreaker.js");

    const call1 = querySsrsExecutionLog({ queryName: "ExecutionLog3" });
    const call1Assertion = expect(call1).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await call1Assertion;

    const call2 = querySsrsExecutionLog({ queryName: "ExecutionLog3" });
    const call2Assertion = expect(call2).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await call2Assertion;

    await expect(querySsrsExecutionLog({ queryName: "ExecutionLog3" })).rejects.toThrow(
      CircuitOpenError
    );

    await vi.advanceTimersByTimeAsync(30_000);
    query.mockResolvedValueOnce({ recordset: [{ instance_name: "SSRS01" }] });

    await expect(querySsrsExecutionLog({ queryName: "ExecutionLog3" })).resolves.toEqual([
      { instance_name: "SSRS01" },
    ]);
  });
});
