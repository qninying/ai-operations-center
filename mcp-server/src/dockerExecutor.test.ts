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
