import { describe, it, expect, afterEach, vi } from "vitest";

// Mocks pg's Pool directly, same shared-mock-driven-by-a-queryImpl approach
// pgRemediationExecutor.test.ts already uses for pg.Client -- here it's
// pool.connect() returning a client-like object with query()/release().
describe("checkPostgresBackendBlocked", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function mockPool(queryImpl: (sqlText: string, params: unknown[]) => Promise<unknown>) {
    const release = vi.fn();
    const query = vi.fn((sqlText: string, params: unknown[]) => queryImpl(sqlText, params));
    const connect = vi.fn().mockResolvedValue({ query, release });
    const Pool = vi.fn(function MockPool() {
      return { connect };
    });
    vi.doMock("pg", () => ({ default: { Pool } }));
    vi.doMock("./pgActivitySource.js", () => ({
      readPgDemoConfig: () => ({ host: "localhost", port: 5434, database: "orders", user: "app", password: "app" }),
    }));
    return { connect, query, release };
  }

  it("happy path: a real blocked backend is found and reported", async () => {
    mockPool(async () => ({
      rows: [
        {
          pid: 4821,
          state: "active",
          query: "UPDATE orders SET status = 'shipped' WHERE id = 1;",
          wait_event_type: "Lock",
          datname: "orders",
          backend_type: "client backend",
          blocked_by: [4790],
        },
      ],
    }));
    const { checkPostgresBackendBlocked } = await import("./pgBackendStatusSource.js");

    const status = await checkPostgresBackendBlocked(4821);

    expect(status).toMatchObject({ pid: 4821, found: true, blockedBy: [4790], datname: "orders" });
  });

  it("a pid that doesn't exist reports found: false, not an error", async () => {
    mockPool(async () => ({ rows: [] }));
    const { checkPostgresBackendBlocked } = await import("./pgBackendStatusSource.js");

    const status = await checkPostgresBackendBlocked(99999);

    expect(status).toEqual({
      pid: 99999,
      found: false,
      state: null,
      query: null,
      waitEventType: null,
      datname: null,
      backendType: null,
      blockedBy: [],
    });
  });

  it("the pid is passed as a bound parameter, never concatenated into the query text", async () => {
    const { query } = mockPool(async () => ({ rows: [] }));
    const { checkPostgresBackendBlocked } = await import("./pgBackendStatusSource.js");

    await checkPostgresBackendBlocked(4821);

    const [sqlText, params] = query.mock.calls[0];
    expect(sqlText).toContain("$1");
    expect(sqlText).not.toContain("4821");
    expect(params).toEqual([4821]);
  });

  it("releases the client back to the pool on every attempt, even when the query fails and withReliability retries", async () => {
    vi.useFakeTimers();
    const { release } = mockPool(async () => {
      throw new Error("connection reset");
    });
    const { checkPostgresBackendBlocked } = await import("./pgBackendStatusSource.js");

    const resultPromise = checkPostgresBackendBlocked(4821);
    // Attach the rejection expectation before advancing timers, not after --
    // otherwise the rejection fires during advanceTimersByTimeAsync with
    // nothing listening yet, and Vitest reports it as unhandled.
    const assertion = expect(resultPromise).rejects.toThrow();
    // Same 4-attempt cap (maxRetries: 3) every other pg source in this repo
    // uses -- advance through all the real backoff delays between them.
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    // Once per attempt: a client borrowed and never left unreleased, not just
    // released once overall.
    expect(release).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });
});
