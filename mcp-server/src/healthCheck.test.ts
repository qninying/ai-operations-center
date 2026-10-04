import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkDependencyHealth, __resetHealthCacheForTests } from "./healthCheck.js";
import { DmvReadResult } from "./dmvReader.js";

beforeEach(() => {
  __resetHealthCacheForTests();
});

function makeClock(startAt = 0) {
  let time = startAt;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("checkDependencyHealth", () => {
  it("reports sqlServer.source: live when the DMV probe reaches a real server (happy path)", async () => {
    const readDmvFn = vi.fn().mockResolvedValue({ source: "live", rows: [] } satisfies DmvReadResult);

    const report = await checkDependencyHealth({ readDmvFn, anthropicKeyPresent: true });

    expect(report.status).toBe("ok");
    expect(report.sqlServer.source).toBe("live");
    expect(report.anthropic.configured).toBe(true);
    expect(readDmvFn).toHaveBeenCalledOnce();
  });

  it("reports sqlServer.source: fallback honestly, rather than a fake live status (failure path)", async () => {
    const readDmvFn = vi.fn().mockResolvedValue({ source: "fallback", rows: [] } satisfies DmvReadResult);

    const report = await checkDependencyHealth({ readDmvFn, anthropicKeyPresent: true });

    expect(report.sqlServer.source).toBe("fallback");
    expect(report.status).toBe("ok"); // a degraded-but-serving dependency is not a broken health route
  });

  it("reports anthropic.configured: false when no API key is present", async () => {
    const readDmvFn = vi.fn().mockResolvedValue({ source: "live", rows: [] } satisfies DmvReadResult);

    const report = await checkDependencyHealth({ readDmvFn, anthropicKeyPresent: false });

    expect(report.anthropic.configured).toBe(false);
  });

  it("caches the report and does not re-probe SQL Server within the TTL", async () => {
    const clock = makeClock();
    const readDmvFn = vi.fn().mockResolvedValue({ source: "live", rows: [] } satisfies DmvReadResult);

    await checkDependencyHealth({ readDmvFn, now: clock.now, anthropicKeyPresent: true });
    clock.advance(5_000);
    await checkDependencyHealth({ readDmvFn, now: clock.now, anthropicKeyPresent: true });

    expect(readDmvFn).toHaveBeenCalledOnce();
  });

  it("re-probes SQL Server once the cache TTL has elapsed (boundary)", async () => {
    const clock = makeClock();
    const readDmvFn = vi.fn().mockResolvedValue({ source: "live", rows: [] } satisfies DmvReadResult);

    await checkDependencyHealth({ readDmvFn, now: clock.now, anthropicKeyPresent: true });
    clock.advance(15_001);
    await checkDependencyHealth({ readDmvFn, now: clock.now, anthropicKeyPresent: true });

    expect(readDmvFn).toHaveBeenCalledTimes(2);
  });

  // INCIDENT-003: "configured" alone already caused one real incident (a key
  // present but rejected by Anthropic looked identical to a working one). These
  // cover the fix: reporting the real outcome of the last actual call, not a
  // second, spend-generating probe call made here.
  it("reports lastCallOutcome: null when no real Anthropic call has happened yet this process", async () => {
    const readDmvFn = vi.fn().mockResolvedValue({ source: "live", rows: [] } satisfies DmvReadResult);

    const report = await checkDependencyHealth({ readDmvFn, anthropicKeyPresent: true, anthropicReachability: null });

    expect(report.anthropic.lastCallOutcome).toBeNull();
    expect(report.anthropic.lastCallAt).toBeNull();
    expect(report.anthropic.lastCallErrorClass).toBeUndefined();
  });

  it("reports a real successful call's outcome, configured true and a genuinely working key look identical no longer", async () => {
    const readDmvFn = vi.fn().mockResolvedValue({ source: "live", rows: [] } satisfies DmvReadResult);

    const report = await checkDependencyHealth({
      readDmvFn,
      anthropicKeyPresent: true,
      anthropicReachability: { outcome: "success", at: "2026-10-04T12:00:00.000Z" },
    });

    expect(report.anthropic.configured).toBe(true);
    expect(report.anthropic.lastCallOutcome).toBe("success");
    expect(report.anthropic.lastCallAt).toBe("2026-10-04T12:00:00.000Z");
  });

  it("reports a real failed call honestly even while configured stays true — the exact INCIDENT-003 gap", async () => {
    const readDmvFn = vi.fn().mockResolvedValue({ source: "live", rows: [] } satisfies DmvReadResult);

    const report = await checkDependencyHealth({
      readDmvFn,
      anthropicKeyPresent: true,
      anthropicReachability: {
        outcome: "failure",
        at: "2026-10-04T12:00:00.000Z",
        errorClass: "AuthenticationError",
      },
    });

    expect(report.anthropic.configured).toBe(true);
    expect(report.anthropic.lastCallOutcome).toBe("failure");
    expect(report.anthropic.lastCallErrorClass).toBe("AuthenticationError");
  });
});
