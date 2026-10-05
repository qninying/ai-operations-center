// The real outcome of the most recent check this process made against each
// external source, so GET /health/dependencies (and the public Command Center's
// Systems tab, which reads it) can report live status honestly.
//
// Same reasoning as anthropicReachability.ts: no new probe is made just to
// answer a health poll. incidentFeedService.ts already checks SQL Server, SSRS,
// cloud, PostgreSQL and Apache Superset every few seconds; notificationService.ts
// already delivers ntfy pushes; flyMachinesExecutor.ts already calls Fly's API on
// an approved restart. Each records its real result here as a side effect.
//
// null for a source means "no check has happened yet this process" (e.g. right
// after a deploy, or ntfy before any incident has paged anyone): an honest
// unknown, never presented as "ok". In-memory on purpose: a restart resets it,
// and the next poll repopulates it within seconds.

export type ReachabilitySource = "sql" | "ssrs" | "cloud" | "postgres" | "superset" | "ntfy" | "flyMachinesApi";

export interface SourceCheckState {
  outcome: "success" | "failure";
  at: string;
  // Only for sources with a fixture fallback (SQL Server, SSRS): "fallback"
  // means the check "succeeded" by serving clearly-tagged sample data because
  // the real system was unreachable, which the page must not show as live.
  sourceMode?: "live" | "fallback";
  errorClass?: string;
}

export type SourceChecks = Record<ReachabilitySource, SourceCheckState | null>;

const ALL_SOURCES: ReachabilitySource[] = ["sql", "ssrs", "cloud", "postgres", "superset", "ntfy", "flyMachinesApi"];

const lastChecks = new Map<ReachabilitySource, SourceCheckState>();

export function recordSourceCheck(
  source: ReachabilitySource,
  outcome: "success" | "failure",
  extra: { sourceMode?: "live" | "fallback"; errorClass?: string } = {},
  now: () => number = Date.now
): void {
  lastChecks.set(source, {
    outcome,
    at: new Date(now()).toISOString(),
    ...(extra.sourceMode ? { sourceMode: extra.sourceMode } : {}),
    ...(extra.errorClass ? { errorClass: extra.errorClass } : {}),
  });
}

export function getSourceChecks(): SourceChecks {
  const out = {} as SourceChecks;
  for (const source of ALL_SOURCES) out[source] = lastChecks.get(source) ?? null;
  return out;
}

export function __resetSourceReachabilityForTests(): void {
  lastChecks.clear();
}
