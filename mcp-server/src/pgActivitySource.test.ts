import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

// Same reliability budget as the other live sources: 10s timeout, 3 retries (4
// attempts total), circuit breaker opens after 5 accumulated failures in a 60s
// window. Fake timers throughout so retry backoff and cooldown cost no real
// wall-clock time. Mocks the pg module's Client class directly, same isolation
// approach dmvLiveSource.test.ts uses for mssql.
describe("queryPgActivity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function mockClient(overrides: { connect?: () => Promise<void>; query?: () => Promise<unknown> }) {
    const connect = overrides.connect ?? vi.fn().mockResolvedValue(undefined);
    const query =
      overrides.query ??
      vi.fn().mockResolvedValue({
        rows: [
          {
            pid: 4821,
            state: "active",
            query: "UPDATE orders SET status = 'shipped' WHERE id = 1;",
            query_start: "2026-08-27T22:00:00Z",
            wait_event_type: "Lock",
            datname: "orders",
            backend_type: "client backend",
            blocked_by: [4790],
          },
        ],
      });
    const end = vi.fn().mockResolvedValue(undefined);
    const Client = vi.fn(function MockClient() {
      return { connect, query, end };
    });
    return { Client, connect, query, end };
  }

  it("resolves with real blocked-backend rows on a successful query", async () => {
    const { Client, end } = mockClient({});
    vi.doMock("pg", () => ({ default: { Client } }));
    const { queryPgActivity } = await import("./pgActivitySource.js");

    const rows = await queryPgActivity();

    expect(rows).toHaveLength(1);
    expect(rows[0].pid).toBe(4821);
    expect(rows[0].blocked_by).toEqual([4790]);
    expect(end).toHaveBeenCalled();
  });

  it("failure path: connection refused — retries then throws UpstreamCallFailedError", async () => {
    const { Client } = mockClient({ connect: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) });
    vi.doMock("pg", () => ({ default: { Client } }));
    const { queryPgActivity } = await import("./pgActivitySource.js");
    const { UpstreamCallFailedError } = await import("./reliability/withReliability.js");

    const resultPromise = queryPgActivity();
    const assertion = expect(resultPromise).rejects.toThrow(UpstreamCallFailedError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(Client).toHaveBeenCalledTimes(4);
  });

  it("opens the circuit breaker once failures cross the threshold, then fails fast without attempting a connection", async () => {
    const { Client } = mockClient({ connect: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) });
    vi.doMock("pg", () => ({ default: { Client } }));
    const { queryPgActivity } = await import("./pgActivitySource.js");
    const { CircuitOpenError } = await import("./reliability/circuitBreaker.js");

    const call1 = queryPgActivity();
    const call1Assertion = expect(call1).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await call1Assertion;

    const call2 = queryPgActivity();
    const call2Assertion = expect(call2).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await call2Assertion;

    Client.mockClear();

    await expect(queryPgActivity()).rejects.toThrow(CircuitOpenError);
    expect(Client).not.toHaveBeenCalled();
  });
});
