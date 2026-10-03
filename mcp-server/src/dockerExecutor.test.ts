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

// DEMO_TARGET=prod: the same two restart functions, but pointed at the
// Fly-hosted sidecar apps instead of local Docker. docker's execFile must
// never be called on this path — restartFlyMachine (mocked via global.fetch,
// since it's a plain POST under the hood) is the only thing that runs.
describe("restartSupersetContainer / restartPostgresContainer under DEMO_TARGET=prod", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.DEMO_TARGET = "prod";
    process.env.FLY_DEV_SUPERSET_APP = "dev-superset";
    process.env.FLY_DEV_SUPERSET_MACHINE_ID = "machine-superset-1";
    process.env.FLY_DEV_POSTGRES_APP = "dev-postgres";
    process.env.FLY_DEV_POSTGRES_MACHINE_ID = "machine-postgres-1";
    process.env.FLY_DEV_SUPERSET_API_TOKEN = "fo1_superset-token";
    process.env.FLY_DEV_POSTGRES_API_TOKEN = "fo1_postgres-token";
    process.env.SUPERSET_PROD_URL = "http://dev-superset.internal:8088";
    process.env.PG_PROD_HOST = "dev-postgres.internal";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    for (const key of [
      "DEMO_TARGET",
      "FLY_DEV_SUPERSET_APP",
      "FLY_DEV_SUPERSET_MACHINE_ID",
      "FLY_DEV_POSTGRES_APP",
      "FLY_DEV_POSTGRES_MACHINE_ID",
      "FLY_DEV_SUPERSET_API_TOKEN",
      "FLY_DEV_POSTGRES_API_TOKEN",
      "SUPERSET_PROD_URL",
      "PG_PROD_HOST",
    ]) {
      delete process.env[key];
    }
  });

  it("restartSupersetContainer: calls the Fly Machines API, never execFile, and polls the prod health URL", async () => {
    const execFile = vi.fn((_cmd, _args, callback) => callback(null));
    vi.doMock("node:child_process", () => ({ execFile }));
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    const { restartSupersetContainer } = await import("./dockerExecutor.js");

    const outcome = await restartSupersetContainer();

    expect(outcome).toEqual({ attempted: true, confirmedHealthy: true, waitedMs: 0 });
    expect(execFile).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.machines.dev/v1/apps/dev-superset/machines/machine-superset-1/restart",
      { method: "POST", headers: { Authorization: "Bearer fo1_superset-token" } }
    );
    expect(global.fetch).toHaveBeenCalledWith("http://dev-superset.internal:8088/health");
  });

  it("restartSupersetContainer: a failed Fly restart call raises FlyMachineRestartFailedError, never polls health", async () => {
    const execFile = vi.fn((_cmd, _args, callback) => callback(null));
    vi.doMock("node:child_process", () => ({ execFile }));
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" } as Response);
    const { restartSupersetContainer } = await import("./dockerExecutor.js");
    const { FlyMachineRestartFailedError } = await import("./flyMachinesExecutor.js");

    await expect(restartSupersetContainer()).rejects.toThrow(FlyMachineRestartFailedError);
    expect(execFile).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("restartPostgresContainer: calls the Fly Machines API for dev-postgres's own app/machine, never execFile", async () => {
    const execFile = vi.fn((_cmd, _args, callback) => callback(null));
    vi.doMock("node:child_process", () => ({ execFile }));
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    const connect = vi.fn().mockResolvedValue(undefined);
    const query = vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] });
    const end = vi.fn().mockResolvedValue(undefined);
    const Client = vi.fn(function MockClient() {
      return { connect, query, end };
    });
    vi.doMock("pg", () => ({ default: { Client } }));
    const { restartPostgresContainer } = await import("./dockerExecutor.js");

    const outcome = await restartPostgresContainer();

    expect(outcome).toEqual({ attempted: true, confirmedHealthy: true, waitedMs: 0 });
    expect(execFile).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.machines.dev/v1/apps/dev-postgres/machines/machine-postgres-1/restart",
      { method: "POST", headers: { Authorization: "Bearer fo1_postgres-token" } }
    );
    expect(connect).toHaveBeenCalled();
  });
});
