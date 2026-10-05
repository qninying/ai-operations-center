import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { SourceConnector, DashboardIncident } from "./types.js";

// STORY-013 / REQ-018 acceptance tests for the plug-in connector architecture.
// Each test imports fresh modules (vi.resetModules) so the registry, the feed's
// in-memory state and the reachability record never leak between tests.

vi.mock("../observability/logger.js", () => ({ logEvent: vi.fn() }));
vi.mock("../notificationService.js", () => ({ notifyOperators: vi.fn().mockResolvedValue(undefined) }));

function incident(source: string, n: number): DashboardIncident {
  return {
    id: `${source}:item:${n}`,
    source,
    title: `${source} problem ${n}`,
    detail: "test",
    severity: "warning",
    occurredAt: "2026-10-05T12:00:00.000Z",
    sourceMode: "live",
  };
}

function connector(id: string, discover: () => Promise<DashboardIncident[]>, reachabilityName = id): SourceConnector {
  return { id, system: `${id} system`, reachabilityName, discoverIncidents: discover };
}

describe("connector registry (REQ-018)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    const reg = await import("./index.js");
    reg.__resetConnectorsForTests();
    vi.useRealTimers();
    vi.resetModules();
  });

  it("a new connector, registered once, appears in the feed and in /health/dependencies with no edits to the feed, health check or reachability code", async () => {
    const reg = await import("./index.js");
    // Recording through the shared helper is what a real connector file does.
    const { recordCheckSuccess } = await import("./sourceCheck.js");
    const kafka: SourceConnector = connector("kafka", async () => {
      recordCheckSuccess(kafka);
      return [incident("kafka", 1)];
    });
    reg.__setConnectorsForTests([kafka]);

    const { startIncidentFeed, getRevealedIncidents } = await import("../incidentFeedService.js");
    const handle = startIncidentFeed();
    await vi.advanceTimersByTimeAsync(0);
    expect(getRevealedIncidents().map((i) => i.id)).toEqual(["kafka:item:1"]);
    handle.stop();

    const { checkDependencyHealth, __resetHealthCacheForTests } = await import("../healthCheck.js");
    __resetHealthCacheForTests();
    const report = await checkDependencyHealth({
      readDmvFn: async () => ({ source: "live", rows: [] }),
      anthropicKeyPresent: true,
      anthropicReachability: null,
    });
    expect(report.sources.kafka).toMatchObject({ outcome: "success" });
    expect(Object.keys(report.sources)).toEqual(["kafka", "ntfy", "flyMachinesApi"]);
  });

  it("failure path: one connector throws and another hangs, yet every other connector's incidents still appear within the timeout", async () => {
    const reg = await import("./index.js");
    reg.__setConnectorsForTests([
      connector("good", async () => [incident("good", 1)]),
      connector("broken", async () => {
        throw new Error("upstream down");
      }),
      connector("hung", () => new Promise<DashboardIncident[]>(() => {})),
    ]);

    const { startIncidentFeed, getRevealedIncidents } = await import("../incidentFeedService.js");
    const handle = startIncidentFeed();
    await vi.advanceTimersByTimeAsync(reg.CONNECTOR_TIMEOUT_MS + 1);
    expect(getRevealedIncidents().map((i) => i.id)).toEqual(["good:item:1"]);

    // The hung connector never logged its own failure; the feed records it.
    const { getSourceChecks } = await import("../sourceReachability.js");
    expect(getSourceChecks(["hung"]).hung).toMatchObject({ outcome: "failure", errorClass: "ConnectorTimeoutError" });
    handle.stop();
  });

  it("a hung connector is treated as 'couldn't check', so its existing incidents are kept, not pruned as cleared", async () => {
    const reg = await import("./index.js");
    let hang = false;
    reg.__setConnectorsForTests([
      connector("flaky", () => (hang ? new Promise<DashboardIncident[]>(() => {}) : Promise.resolve([incident("flaky", 1)]))),
    ]);
    const { startIncidentFeed, getRevealedIncidents } = await import("../incidentFeedService.js");
    const handle = startIncidentFeed();
    await vi.advanceTimersByTimeAsync(0);
    expect(getRevealedIncidents()).toHaveLength(1);

    hang = true;
    await vi.advanceTimersByTimeAsync(3_000 + reg.CONNECTOR_TIMEOUT_MS + 1);
    expect(getRevealedIncidents().map((i) => i.id)).toEqual(["flaky:item:1"]);
    handle.stop();
  });

  it("two connectors sharing an id fail fast, naming the duplicate", async () => {
    const reg = await import("./index.js");
    expect(() =>
      reg.validateConnectors([connector("sql", async () => []), connector("sql", async () => [])])
    ).toThrow(/same id "sql"/);
  });

  it("two connectors sharing a reachabilityName also fail fast", async () => {
    const reg = await import("./index.js");
    expect(() =>
      reg.validateConnectors([connector("a", async () => [], "shared"), connector("b", async () => [], "shared")])
    ).toThrow(reg.DuplicateConnectorError);
  });

  it("the real registry holds exactly the five migrated sources, with unique ids", async () => {
    const reg = await import("./index.js");
    expect(reg.getConnectors().map((c) => [c.id, c.system, c.reachabilityName])).toEqual([
      ["sql", "SQL Server", "sql"],
      ["ssrs", "SSRS", "ssrs"],
      ["cloud", "SSIS", "cloud"],
      ["docker", "Apache Superset", "superset"],
      ["postgres", "PostgreSQL", "postgres"],
    ]);
  });
});
