import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

// Mocks node:child_process's execFile (callback style) and global.fetch
// directly, fake timers throughout — same isolation approach
// supersetHealthSource.test.ts uses for its own module-level state.
describe("restartSupersetContainer", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("happy path: restart succeeds and health confirms quickly", async () => {
    const execFile = vi.fn((_cmd, _args, callback) => callback(null));
    vi.doMock("node:child_process", () => ({ execFile }));
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    const { restartSupersetContainer } = await import("./dockerExecutor.js");

    const outcome = await restartSupersetContainer();

    expect(outcome).toEqual({ attempted: true, confirmedHealthy: true, waitedMs: 0 });
    expect(execFile).toHaveBeenCalledWith("docker", ["restart", "coreops-dev-superset"], expect.any(Function));
    expect(global.fetch).toHaveBeenCalledWith("http://localhost:8088/health");
  });

  it("failure path: the docker command itself fails (daemon unreachable) — rejects, never polls health", async () => {
    const execFile = vi.fn((_cmd, _args, callback) => callback(new Error("connect ENOENT /var/run/docker.sock")));
    vi.doMock("node:child_process", () => ({ execFile }));
    global.fetch = vi.fn();
    const { restartSupersetContainer, DockerRestartFailedError } = await import("./dockerExecutor.js");

    await expect(restartSupersetContainer()).rejects.toThrow(DockerRestartFailedError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("unconfirmed path: restart succeeds but health never returns before the 45s ceiling", async () => {
    const execFile = vi.fn((_cmd, _args, callback) => callback(null));
    vi.doMock("node:child_process", () => ({ execFile }));
    global.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const { restartSupersetContainer } = await import("./dockerExecutor.js");

    const resultPromise = restartSupersetContainer();
    await vi.advanceTimersByTimeAsync(45_000);
    const outcome = await resultPromise;

    expect(outcome.attempted).toBe(true);
    expect(outcome.confirmedHealthy).toBe(false);
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(45_000);
  });

  it("recovers mid-poll: health fails a few times, then succeeds, without waiting the full ceiling", async () => {
    const execFile = vi.fn((_cmd, _args, callback) => callback(null));
    vi.doMock("node:child_process", () => ({ execFile }));
    global.fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue({ ok: true, status: 200 } as Response);
    const { restartSupersetContainer } = await import("./dockerExecutor.js");

    const resultPromise = restartSupersetContainer();
    await vi.advanceTimersByTimeAsync(6_000); // two failed polls, 3s apart
    const outcome = await resultPromise;

    expect(outcome.confirmedHealthy).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
});

// Same restart-then-poll mechanism as restartSupersetContainer above, second
// target — mocks pg's Client the same way pgRemediationExecutor.test.ts does,
// instead of global.fetch, since the health probe here is a real connect +
// query, not an HTTP call.
describe("restartPostgresContainer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function mockPg(connectImpl: () => Promise<void>) {
    const connect = vi.fn(connectImpl);
    const query = vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] });
    const end = vi.fn().mockResolvedValue(undefined);
    const Client = vi.fn(function MockClient() {
      return { connect, query, end };
    });
    vi.doMock("pg", () => ({ default: { Client } }));
    return { Client, connect, query, end };
  }

  it("happy path: restart succeeds and Postgres reachability confirms quickly", async () => {
    const execFile = vi.fn((_cmd, _args, callback) => callback(null));
    vi.doMock("node:child_process", () => ({ execFile }));
    mockPg(() => Promise.resolve());
    const { restartPostgresContainer } = await import("./dockerExecutor.js");

    const outcome = await restartPostgresContainer();

    expect(outcome).toEqual({ attempted: true, confirmedHealthy: true, waitedMs: 0 });
    expect(execFile).toHaveBeenCalledWith("docker", ["restart", "coreops-dev-postgres"], expect.any(Function));
  });

  it("failure path: the docker command itself fails (daemon unreachable) — rejects, never polls reachability", async () => {
    const execFile = vi.fn((_cmd, _args, callback) => callback(new Error("connect ENOENT /var/run/docker.sock")));
    vi.doMock("node:child_process", () => ({ execFile }));
    const { connect } = mockPg(() => Promise.resolve());
    const { restartPostgresContainer, DockerRestartFailedError } = await import("./dockerExecutor.js");

    await expect(restartPostgresContainer()).rejects.toThrow(DockerRestartFailedError);
    expect(connect).not.toHaveBeenCalled();
  });

  it("unconfirmed path: restart succeeds but Postgres never becomes reachable before the 45s ceiling", async () => {
    const execFile = vi.fn((_cmd, _args, callback) => callback(null));
    vi.doMock("node:child_process", () => ({ execFile }));
    mockPg(() => Promise.reject(new Error("ECONNREFUSED")));
    const { restartPostgresContainer } = await import("./dockerExecutor.js");

    const resultPromise = restartPostgresContainer();
    await vi.advanceTimersByTimeAsync(45_000);
    const outcome = await resultPromise;

    expect(outcome.attempted).toBe(true);
    expect(outcome.confirmedHealthy).toBe(false);
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(45_000);
  });

  it("recovers mid-poll: reachability fails a few times, then succeeds, without waiting the full ceiling", async () => {
    const execFile = vi.fn((_cmd, _args, callback) => callback(null));
    vi.doMock("node:child_process", () => ({ execFile }));
    const { connect } = mockPg(() => Promise.resolve());
    connect
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue(undefined);
    const { restartPostgresContainer } = await import("./dockerExecutor.js");

    const resultPromise = restartPostgresContainer();
    await vi.advanceTimersByTimeAsync(6_000); // two failed polls, 3s apart
    const outcome = await resultPromise;

    expect(outcome.confirmedHealthy).toBe(true);
    expect(connect).toHaveBeenCalledTimes(3);
  });
});
