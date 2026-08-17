import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

const ENV_KEYS = ["SQLSERVER_HOST", "SQLSERVER_DATABASE", "SQLSERVER_USER", "SQLSERVER_PASSWORD"];

function clearSqlEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function setSqlEnv() {
  process.env.SQLSERVER_HOST = "test-host";
  process.env.SQLSERVER_DATABASE = "test-db";
  process.env.SQLSERVER_USER = "test-user";
  process.env.SQLSERVER_PASSWORD = "test-password";
}

// Registers a mocked mssql module and returns its spies. query() defaults to
// rejecting every call — override with mockResolvedValueOnce/mockRejectedValueOnce
// per test as needed. Must be called before the dynamic import of dmvLiveSource.js.
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

// R5 spec baked into dmvLiveSource.ts: 10s timeout, 3 retries (4 attempts total),
// exponential backoff (500ms, 1000ms, 2000ms between attempts — 3500ms total), and a
// circuit breaker that opens after 5 accumulated failures within a 60s window. Using
// fake timers throughout so retry backoff and cooldown don't cost real wall-clock
// time; vitest's fake timers also fake Date, which the circuit breaker's clock
// (Date.now() by default) relies on.
describe("queryLiveDmv", () => {
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

  it("throws LiveSourceUnavailableError listing every missing env var, without attempting a connection", async () => {
    clearSqlEnv();
    const { queryLiveDmv, LiveSourceUnavailableError } = await import("./dmvLiveSource.js");

    await expect(queryLiveDmv({ dmvName: "sys.dm_exec_requests" })).rejects.toThrow(
      LiveSourceUnavailableError
    );
  });

  it("retries 3 times (4 attempts total) with backoff, then throws UpstreamCallFailedError", async () => {
    setSqlEnv();
    const query = vi.fn().mockRejectedValue(new Error("connection reset"));
    const { connect } = mockMssql(query);

    const { queryLiveDmv } = await import("./dmvLiveSource.js");
    const { UpstreamCallFailedError } = await import("./reliability/withReliability.js");

    const resultPromise = queryLiveDmv({ dmvName: "sys.dm_exec_requests" });
    // Attach the rejection assertion before advancing timers — the promise settles
    // *during* the advance, so a handler must already be attached or Node reports an
    // (otherwise harmless) unhandled-rejection warning even though we do assert on it.
    const assertion = expect(resultPromise).rejects.toThrow(UpstreamCallFailedError);
    await vi.advanceTimersByTimeAsync(10_000); // comfortably more than the 3500ms of backoff
    await assertion;

    expect(connect).toHaveBeenCalledTimes(4);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("succeeds on a later retry without exhausting all attempts", async () => {
    setSqlEnv();
    const rows = [{ session_id: 1 }];
    const query = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({ recordset: rows });
    mockMssql(query);

    const { queryLiveDmv } = await import("./dmvLiveSource.js");

    const resultPromise = queryLiveDmv({ dmvName: "sys.dm_exec_requests" });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(resultPromise).resolves.toEqual(rows);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("parameterizes databaseName via a bound input rather than concatenating it into the query text", async () => {
    setSqlEnv();
    const injectionAttempt = "Sneaky'; DROP TABLE dbo.Users; --";
    const query = vi.fn().mockResolvedValue({ recordset: [] });
    const { input } = mockMssql(query);

    const { queryLiveDmv } = await import("./dmvLiveSource.js");
    await queryLiveDmv({ dmvName: "sys.dm_exec_requests", databaseName: injectionAttempt });

    expect(input).toHaveBeenCalledWith("databaseName", "NVarChar", injectionAttempt);
    const queryText = query.mock.calls[0][0] as string;
    expect(queryText).not.toContain(injectionAttempt);
    expect(queryText).toContain("@databaseName");
  });

  it("opens the circuit breaker once failures cross the threshold, then fails fast without attempting a connection", async () => {
    setSqlEnv();
    const query = vi.fn().mockRejectedValue(new Error("down"));
    const { connect } = mockMssql(query);

    const { queryLiveDmv } = await import("./dmvLiveSource.js");
    const { CircuitOpenError } = await import("./reliability/circuitBreaker.js");

    // Each fully-exhausted call records 4 failures (4 attempts). The breaker's
    // threshold is 5, so the 5th failure — the 1st attempt of the 2nd call — trips
    // it; that call's remaining attempts short-circuit with CircuitOpenError instead
    // of continuing to retry against a now-known-broken upstream.
    const call1 = queryLiveDmv({ dmvName: "sys.dm_exec_requests" });
    const call1Assertion = expect(call1).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await call1Assertion;

    const call2 = queryLiveDmv({ dmvName: "sys.dm_exec_requests" });
    const call2Assertion = expect(call2).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await call2Assertion;

    connect.mockClear();
    query.mockClear();

    await expect(queryLiveDmv({ dmvName: "sys.dm_exec_requests" })).rejects.toThrow(
      CircuitOpenError
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("allows a half-open trial call after the cooldown elapses, and closes again on success", async () => {
    setSqlEnv();
    const query = vi.fn().mockRejectedValue(new Error("down"));
    mockMssql(query);

    const { queryLiveDmv } = await import("./dmvLiveSource.js");
    const { CircuitOpenError } = await import("./reliability/circuitBreaker.js");

    // Trip the breaker (see previous test for the failure-accounting math).
    const call1 = queryLiveDmv({ dmvName: "sys.dm_exec_requests" });
    const call1Assertion = expect(call1).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await call1Assertion;

    const call2 = queryLiveDmv({ dmvName: "sys.dm_exec_requests" });
    const call2Assertion = expect(call2).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await call2Assertion;

    await expect(queryLiveDmv({ dmvName: "sys.dm_exec_requests" })).rejects.toThrow(
      CircuitOpenError
    );

    // Cooldown is 30s from when the breaker opened (partway through call2's fake
    // time); advance comfortably past that, then let the trial call succeed.
    await vi.advanceTimersByTimeAsync(30_000);
    query.mockResolvedValueOnce({ recordset: [{ session_id: 1 }] });

    await expect(queryLiveDmv({ dmvName: "sys.dm_exec_requests" })).resolves.toEqual([
      { session_id: 1 },
    ]);
  });
});
