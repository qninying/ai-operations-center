import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

// Same reliability budget as the other three live sources: 10s timeout, 3
// retries (4 attempts total), circuit breaker opens after 5 accumulated
// failures in a 60s window. Fake timers throughout so retry backoff and
// cooldown cost no real wall-clock time. Mocks global fetch directly, since
// this module (unlike the SQL/SSRS/Blob sources) talks plain HTTP, not an SDK.
describe("checkSupersetHealth", () => {
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

  it("resolves on a real 200 from Superset's own /health route", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    const { checkSupersetHealth } = await import("./supersetHealthSource.js");

    await expect(checkSupersetHealth()).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledWith("http://localhost:8088/health");
  });

  it("failure path — connection refused: translates the raw fetch TypeError into SupersetUnavailableError, not an uncaught crash", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const { checkSupersetHealth } = await import("./supersetHealthSource.js");
    const { UpstreamCallFailedError } = await import("./reliability/withReliability.js");

    const resultPromise = checkSupersetHealth();
    const assertion = expect(resultPromise).rejects.toThrow(UpstreamCallFailedError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it("failure path — non-ok response: retries then throws UpstreamCallFailedError", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response);
    const { checkSupersetHealth } = await import("./supersetHealthSource.js");
    const { UpstreamCallFailedError } = await import("./reliability/withReliability.js");

    const resultPromise = checkSupersetHealth();
    const assertion = expect(resultPromise).rejects.toThrow(UpstreamCallFailedError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  it("opens the circuit breaker once failures cross the threshold, then fails fast without attempting a connection", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const { checkSupersetHealth } = await import("./supersetHealthSource.js");
    const { CircuitOpenError } = await import("./reliability/circuitBreaker.js");

    const call1 = checkSupersetHealth();
    const call1Assertion = expect(call1).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await call1Assertion;

    const call2 = checkSupersetHealth();
    const call2Assertion = expect(call2).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await call2Assertion;

    (global.fetch as ReturnType<typeof vi.fn>).mockClear();

    await expect(checkSupersetHealth()).rejects.toThrow(CircuitOpenError);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
