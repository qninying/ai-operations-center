import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

// Mocks pg's Client class directly. Every call (the terminate itself, and
// each confirmation poll) constructs its own new Client — the mock's query
// behavior is driven by one shared, external queryImpl function so test code
// can control what each successive call sees across many `new Client()`
// instantiations, not just the first.
describe("terminatePostgresBackend", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function mockPg(queryImpl: (sqlText: string, params: unknown[]) => Promise<unknown>) {
    const connect = vi.fn().mockResolvedValue(undefined);
    const end = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn((sqlText: string, params: unknown[]) => queryImpl(sqlText, params));
    const Client = vi.fn(function MockClient() {
      return { connect, query, end };
    });
    vi.doMock("pg", () => ({ default: { Client } }));
    return { Client, connect, end, query };
  }

  it("happy path: terminate succeeds, confirmation immediately shows the backend is gone", async () => {
    mockPg(async (sqlText) => {
      if (sqlText.includes("pg_terminate_backend")) return { rows: [] };
      return { rowCount: 0 }; // presence check: not present
    });
    const { terminatePostgresBackend } = await import("./pgRemediationExecutor.js");

    const outcome = await terminatePostgresBackend(4821);

    expect(outcome).toEqual({ attempted: true, confirmedTerminated: true, waitedMs: 0 });
  });

  it("failure path: the terminate command itself fails — rejects, never polls for confirmation", async () => {
    const { query } = mockPg(async () => {
      throw new Error("connection refused");
    });
    const { terminatePostgresBackend, PgTerminateFailedError } = await import("./pgRemediationExecutor.js");

    await expect(terminatePostgresBackend(4821)).rejects.toThrow(PgTerminateFailedError);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("unconfirmed path: terminate succeeds but the backend is still present at the 10s ceiling", async () => {
    mockPg(async (sqlText) => {
      if (sqlText.includes("pg_terminate_backend")) return { rows: [] };
      return { rowCount: 1 }; // presence check: still present, every time
    });
    const { terminatePostgresBackend } = await import("./pgRemediationExecutor.js");

    const resultPromise = terminatePostgresBackend(4821);
    await vi.advanceTimersByTimeAsync(10_000);
    const outcome = await resultPromise;

    expect(outcome.confirmedTerminated).toBe(false);
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(10_000);
  });

  it("recovers mid-poll: still present a couple of checks, then confirmed gone", async () => {
    let presenceChecks = 0;
    mockPg(async (sqlText) => {
      if (sqlText.includes("pg_terminate_backend")) return { rows: [] };
      presenceChecks += 1;
      return { rowCount: presenceChecks <= 2 ? 1 : 0 };
    });
    const { terminatePostgresBackend } = await import("./pgRemediationExecutor.js");

    const resultPromise = terminatePostgresBackend(4821);
    await vi.advanceTimersByTimeAsync(1_500); // three 500ms polls
    const outcome = await resultPromise;

    expect(outcome.confirmedTerminated).toBe(true);
    expect(presenceChecks).toBe(3);
  });
});
