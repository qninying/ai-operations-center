// REQ-018 / STORY-013: the plug-in connector contract. See
// docs/ADR-016-plugin-connector-architecture.md for the full decision record.
//
// A connector is one data source CoreOps watches for incidents. Adding a
// system means writing one file that exports a SourceConnector and adding it to
// the registry in ./index.ts. The incident feed, the reachability record behind
// GET /health/dependencies, and the Command Center's inventory all read the
// registry, so none of them is edited for a new source.
//
// Read-only on purpose. Write paths (*Executor.ts) stay hand-built: each one
// carries its own reversibility argument (ADR-012, ADR-013) and must never
// become something a plug-in can add without review.

export type IncidentSeverity = "warning" | "error" | "critical";

// A connector's own id, e.g. "sql". A plain string rather than a fixed union,
// so a new connector needs no edit to this file.
export type IncidentSource = string;

export interface DashboardIncident {
  id: string;
  source: IncidentSource;
  title: string;
  detail: string;
  severity: IncidentSeverity;
  occurredAt: string;
  sourceMode: "live" | "fallback";
}

export interface SourceConnector {
  // Stable id, used as DashboardIncident.source and in incident ids. Must be
  // unique across the registry (startup fails fast on a duplicate).
  readonly id: string;
  // Human-readable system name, shown in the Command Center.
  readonly system: string;
  // Key under GET /health/dependencies `sources`. Usually equal to `id`;
  // differs only where the dashboard's historical source name (e.g. "docker")
  // isn't the system's real name ("superset"). Also must be unique.
  readonly reachabilityName: string;
  // Returns the incidents currently present in this source.
  //   - Resolve with [] when the source was checked and is genuinely clear.
  //   - Reject when the source couldn't be checked. The feed then keeps this
  //     source's existing incidents instead of treating silence as "all clear".
  // Connectors log and record their own check via ./sourceCheck.ts.
  discoverIncidents(): Promise<DashboardIncident[]>;
}
