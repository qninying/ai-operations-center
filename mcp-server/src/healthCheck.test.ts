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
});
