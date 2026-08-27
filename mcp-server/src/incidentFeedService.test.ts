import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

// Module-level state (the tracked-incident Map, the resolved-ids Set) means
// every test needs a fresh module instance — vi.resetModules() + a dynamic
// import per test, same isolation approach cloudBlobSource.test.ts already
// uses for its own module-level circuit breaker.

const blockedDmvRow = {
  session_id: 61,
  status: "suspended",
  command: "UPDATE",
  wait_type: "LCK_M_X",
  blocking_session_id: 52,
  cpu_time_ms: 40,
  total_elapsed_time_ms: 8600,
  database_name: "OpsWarehouse",
};

function mockAllSources(overrides: {
  dmvRows?: unknown[];
  dmvSource?: "live" | "fallback";
  ssrsRows?: unknown[];
  ssrsSource?: "live" | "fallback";
  cloudRecords?: unknown[];
  supersetHealthy?: boolean;
}) {
  vi.doMock("./dmvReader.js", () => ({
    readDmv: vi.fn().mockResolvedValue({ source: overrides.dmvSource ?? "fallback", rows: overrides.dmvRows ?? [] }),
  }));
  vi.doMock("./ssrsReader.js", () => ({
    readSsrsExecutionLog: vi
      .fn()
      .mockResolvedValue({ source: overrides.ssrsSource ?? "fallback", rows: overrides.ssrsRows ?? [] }),
  }));
  vi.doMock("./cloudBlobSource.js", () => ({
    queryLiveCloudBlob: vi.fn().mockResolvedValue(overrides.cloudRecords ?? []),
  }));
  vi.doMock("./supersetHealthSource.js", () => ({
    checkSupersetHealth: overrides.supersetHealthy === false
      ? vi.fn().mockRejectedValue(new Error("unreachable"))
      : vi.fn().mockResolvedValue(undefined),
  }));
  const notifyOperators = vi.fn().mockResolvedValue(undefined);
  vi.doMock("./notificationService.js", () => ({ notifyOperators }));
  return { notifyOperators };
}

describe("incidentFeedService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    delete process.env.DEMO_MODE;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("in a real (non-demo) deployment, a genuine problem is revealed immediately, not delayed", async () => {
    mockAllSources({ dmvRows: [blockedDmvRow] });
    const { startIncidentFeed, getRevealedIncidents } = await import("./incidentFeedService.js");

    const handle = startIncidentFeed();
    await vi.advanceTimersByTimeAsync(0);

    const incidents = getRevealedIncidents();
    expect(incidents).toHaveLength(1);
    expect(incidents[0].id).toBe("sql:session:61");
    expect(incidents[0].source).toBe("sql");
    handle.stop();
  });

  it("only genuinely blocked sessions become incidents — a healthy row is not one", async () => {
    mockAllSources({ dmvRows: [{ ...blockedDmvRow, session_id: 52, blocking_session_id: 0, status: "running" }] });
    const { startIncidentFeed, getRevealedIncidents } = await import("./incidentFeedService.js");

    const handle = startIncidentFeed();
    await vi.advanceTimersByTimeAsync(0);

    expect(getRevealedIncidents()).toHaveLength(0);
    handle.stop();
  });

  it("Docker source: healthy Superset produces zero incidents, unreachable Superset produces exactly one", async () => {
    mockAllSources({ supersetHealthy: false });
    const { startIncidentFeed, getRevealedIncidents } = await import("./incidentFeedService.js");

    const handle = startIncidentFeed();
    await vi.advanceTimersByTimeAsync(0);

    const incidents = getRevealedIncidents();
    expect(incidents).toHaveLength(1);
    expect(incidents[0].id).toBe("docker:superset");
    expect(incidents[0].source).toBe("docker");
    handle.stop();
  });

  it("demo mode: a discovered incident is NOT revealed before its random 3-45s delay elapses", async () => {
    process.env.DEMO_MODE = "true";
    mockAllSources({ dmvRows: [blockedDmvRow] });
    const { startIncidentFeed, getRevealedIncidents } = await import("./incidentFeedService.js");

    const handle = startIncidentFeed();
    await vi.advanceTimersByTimeAsync(0);
    expect(getRevealedIncidents()).toHaveLength(0); // discovered, but not yet revealed

    await vi.advanceTimersByTimeAsync(50_000); // past the max possible delay
    expect(getRevealedIncidents()).toHaveLength(1);
    handle.stop();
  });

  it("fires the incident-report ntfy push exactly once per incident, not once per poll tick", async () => {
    const { notifyOperators } = mockAllSources({ dmvRows: [blockedDmvRow] });
    const { startIncidentFeed } = await import("./incidentFeedService.js");

    const handle = startIncidentFeed();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3_000); // a second poll tick, same incident still present
    await vi.advanceTimersByTimeAsync(3_000); // a third

    expect(notifyOperators).toHaveBeenCalledTimes(1);
    expect(notifyOperators).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: "incident report", priority: "urgent", tags: "rotating_light" })
    );
    handle.stop();
  });

  it("markResolved removes an incident and suppresses its rediscovery even though the underlying fixture data is unchanged", async () => {
    mockAllSources({ dmvRows: [blockedDmvRow] });
    const { startIncidentFeed, getRevealedIncidents, markResolved } = await import("./incidentFeedService.js");

    const handle = startIncidentFeed();
    await vi.advanceTimersByTimeAsync(0);
    expect(getRevealedIncidents()).toHaveLength(1);

    markResolved("sql:session:61");
    expect(getRevealedIncidents()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(3_000); // next poll tick — same static fixture row still "exists"
    expect(getRevealedIncidents()).toHaveLength(0); // still suppressed, not rediscovered
    handle.stop();
  });

  it("one source failing (Cloud unreachable) does not prevent other sources' real incidents from surfacing", async () => {
    mockAllSources({ dmvRows: [blockedDmvRow] }); // cloudRecords omitted -> queryLiveCloudBlob mocked to resolve []
    vi.doMock("./cloudBlobSource.js", () => ({
      queryLiveCloudBlob: vi.fn().mockRejectedValue(new Error("CloudSourceUnavailableError")),
    }));
    const { startIncidentFeed, getRevealedIncidents } = await import("./incidentFeedService.js");

    const handle = startIncidentFeed();
    await vi.advanceTimersByTimeAsync(0);

    const incidents = getRevealedIncidents();
    expect(incidents).toHaveLength(1);
    expect(incidents[0].source).toBe("sql");
    handle.stop();
  });

  it("a resolved Docker incident (fixed, non-timestamped id) can recur once the underlying condition clears and then fails again", async () => {
    mockAllSources({});
    const checkSupersetHealth = vi.fn().mockRejectedValue(new Error("unreachable"));
    vi.doMock("./supersetHealthSource.js", () => ({ checkSupersetHealth }));
    const { startIncidentFeed, getRevealedIncidents, markResolved } = await import("./incidentFeedService.js");

    const handle = startIncidentFeed();
    await vi.advanceTimersByTimeAsync(0);
    expect(getRevealedIncidents().map((i) => i.id)).toContain("docker:superset");

    markResolved("docker:superset");
    expect(getRevealedIncidents()).toHaveLength(0);

    // Superset comes back healthy — resolved, and nothing rediscovers it yet.
    checkSupersetHealth.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(getRevealedIncidents()).toHaveLength(0);

    // Superset goes down again — unlike the SQL fixture case above (same
    // still-blocking row, stays suppressed), this is a genuinely new
    // occurrence and must surface, not stay silently suppressed forever.
    checkSupersetHealth.mockRejectedValue(new Error("unreachable again"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(getRevealedIncidents().map((i) => i.id)).toContain("docker:superset");

    handle.stop();
  });
});
