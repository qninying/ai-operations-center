import { readDmv } from "./dmvReader.js";
import { readSsrsExecutionLog } from "./ssrsReader.js";
import { queryLiveCloudBlob } from "./cloudBlobSource.js";
import { checkSupersetHealth } from "./supersetHealthSource.js";
import { queryPgActivity } from "./pgActivitySource.js";
import { notifyOperators } from "./notificationService.js";
import { isDemoModeEnabled } from "./demoModeGate.js";
import { logEvent } from "./observability/logger.js";
import { safeLogEvent } from "./observability/safeLogEvent.js";

// Unified, multi-source incident feed: SQL Server (DMV blocking chains), Cloud
// (Blob diagnostics), SSRS (ExecutionLog3), Docker (the dev-superset stack's own
// health), and Postgres (blocking queries, or the dev-postgres container's own
// health) all surface into one list, instead of the dashboard making the user
// pick a single source before it shows anything. Only genuine problems count
// as incidents — a source being unreachable means "can't check this source"
// (logged, not fabricated as a finding), except Docker and Postgres, where
// unreachable IS a real incident of its own — both are local dev containers
// this environment can genuinely detect down and genuinely restart (see
// dockerExecutor.ts), unlike SQL Server/SSRS/Cloud's remote, sometimes-
// legitimately-unreachable dependencies.
//
// Staged reveal is a deliberate, demo-mode-only choice, not baked into "what
// counts as an incident": every discovered incident gets a revealAt timestamp
// (now, in a real deployment; now + a random 3-45s delay in demo mode) assigned
// ONCE, by this background loop — never by a client. That's what keeps the
// reveal and its accompanying ntfy push idempotent and reload-proof: any number
// of browser tabs polling GET /api/incidents at any time all see the exact same
// revealed/not-yet-revealed state, and the push for a given incident fires
// exactly once, from here, regardless of how many times a client reloads.

export type IncidentSource = "sql" | "cloud" | "ssrs" | "docker" | "postgres";
export type IncidentSeverity = "warning" | "error" | "critical";

export interface DashboardIncident {
  id: string;
  source: IncidentSource;
  title: string;
  detail: string;
  severity: IncidentSeverity;
  occurredAt: string;
  sourceMode: "live" | "fallback";
}

interface TrackedIncident {
  incident: DashboardIncident;
  discoveredAt: number;
  revealAt: number;
  revealed: boolean;
  notified: boolean;
}

const MIN_REVEAL_DELAY_MS = 3_000;
const MAX_REVEAL_DELAY_MS = 45_000;
const POLL_INTERVAL_MS = 3_000;

const state = new Map<string, TrackedIncident>();
const resolvedIds = new Set<string>();

function randomRevealDelay(): number {
  return MIN_REVEAL_DELAY_MS + Math.random() * (MAX_REVEAL_DELAY_MS - MIN_REVEAL_DELAY_MS);
}

async function discoverSqlIncidents(): Promise<DashboardIncident[]> {
  try {
    const result = await readDmv({ dmvName: "sys.dm_exec_requests" });
    logEvent({
      level: "info",
      event: "incident_feed_source_check",
      context: { source: "sql", outcome: "success", sourceMode: result.source, rowCount: result.rows.length },
    });
    return result.rows
      .filter((row) => row.blocking_session_id && row.blocking_session_id !== 0)
      .map((row) => ({
        id: `sql:session:${row.session_id}`,
        source: "sql" as const,
        title: `Session ${row.session_id} blocked by session ${row.blocking_session_id}`,
        detail: `${row.command} on ${row.database_name} — ${row.status}${row.wait_type ? " · " + row.wait_type : ""}`,
        severity: "error" as const,
        occurredAt: new Date().toISOString(),
        sourceMode: result.source,
      }));
  } catch (error) {
    logEvent({
      level: "error",
      event: "incident_feed_source_check",
      context: { source: "sql", outcome: "failure", errorClass: error instanceof Error ? error.name : "Error" },
    });
    // Re-thrown, not swallowed into []: tick()'s Promise.allSettled distinguishes
    // "checked, genuinely clear" (fulfilled, empty array) from "couldn't check"
    // (rejected) — collapsing both into [] would make tick()'s stale-incident
    // pruning below treat a transient SQL Server outage as proof every previously
    // active session cleared, silently hiding real incidents during an outage.
    throw error;
  }
}

async function discoverSsrsIncidents(): Promise<DashboardIncident[]> {
  try {
    const result = await readSsrsExecutionLog({ queryName: "ExecutionLog3" });
    logEvent({
      level: "info",
      event: "incident_feed_source_check",
      context: { source: "ssrs", outcome: "success", sourceMode: result.source, rowCount: result.rows.length },
    });
    return result.rows.map((row, index) => ({
      id: `ssrs:${row.report_path}:${row.time_start}:${index}`,
      source: "ssrs" as const,
      title: `SSRS report ${row.report_path} — ${row.status}`,
      detail: `Run by ${row.user_name}, started ${row.time_start}`,
      severity: "error" as const,
      occurredAt: row.time_start,
      sourceMode: result.source,
    }));
  } catch (error) {
    logEvent({
      level: "error",
      event: "incident_feed_source_check",
      context: { source: "ssrs", outcome: "failure", errorClass: error instanceof Error ? error.name : "Error" },
    });
    throw error;
  }
}

function normalizeCloudSeverity(raw: string): IncidentSeverity {
  const lower = raw.toLowerCase();
  if (lower === "critical") return "critical";
  if (lower === "error") return "error";
  return "warning";
}

async function discoverCloudIncidents(): Promise<DashboardIncident[]> {
  try {
    const records = await queryLiveCloudBlob();
    logEvent({
      level: "info",
      event: "incident_feed_source_check",
      context: { source: "cloud", outcome: "success", recordCount: records.length },
    });
    return records.map((record, index) => ({
      id: `cloud:${record.service}:${record.timestamp}:${index}`,
      source: "cloud" as const,
      title: `${record.service}: ${record.severity}`,
      detail: record.message,
      severity: normalizeCloudSeverity(record.severity),
      occurredAt: record.timestamp,
      sourceMode: "live" as const,
    }));
  } catch (error) {
    // Cloud has no fixture-fallback (ADR-era decision: never present fixture
    // data as a real cloud finding) — an unreachable Blob container means "can't
    // check this source," same as SQL/SSRS's live-source failure path, not a
    // finding of its own.
    logEvent({
      level: "error",
      event: "incident_feed_source_check",
      context: { source: "cloud", outcome: "failure", errorClass: error instanceof Error ? error.name : "Error" },
    });
    throw error;
  }
}

async function discoverDockerIncidents(): Promise<DashboardIncident[]> {
  try {
    await checkSupersetHealth();
    logEvent({ level: "info", event: "incident_feed_source_check", context: { source: "docker", outcome: "success" } });
    return [];
  } catch (error) {
    // The one source where "unreachable" IS the incident, not just "can't
    // check" — there's nothing else about Docker/Superset to evaluate.
    logEvent({
      level: "warn",
      event: "incident_feed_source_check",
      context: { source: "docker", outcome: "failure", errorClass: error instanceof Error ? error.name : "Error" },
    });
    return [
      {
        id: "docker:superset",
        source: "docker",
        title: "Superset (dev-superset stack) unreachable",
        detail: "Verify Docker Desktop is running and the dev-superset stack is up (mcp-server/dev-superset/).",
        severity: "warning",
        occurredAt: new Date().toISOString(),
        sourceMode: "live",
      },
    ];
  }
}

async function discoverPostgresIncidents(): Promise<DashboardIncident[]> {
  try {
    const rows = await queryPgActivity();
    logEvent({
      level: "info",
      event: "incident_feed_source_check",
      context: { source: "postgres", outcome: "success", rowCount: rows.length },
    });
    return rows
      .filter((row) => row.blocked_by.length > 0)
      .map((row) => ({
        id: `postgres:pid:${row.pid}`,
        source: "postgres" as const,
        title: `Backend ${row.pid} blocked by ${row.blocked_by[0]}`,
        detail: `${row.query} on ${row.datname} — ${row.state}${row.wait_event_type ? " · " + row.wait_event_type : ""}`,
        severity: "error" as const,
        occurredAt: new Date().toISOString(),
        sourceMode: "live" as const,
      }));
  } catch (error) {
    // Unlike SQL/SSRS/Cloud's remote, sometimes-legitimately-unreachable
    // dependencies, dev-postgres is a fully local, fully-controlled dev
    // container (same reasoning pgActivitySource.ts's own header comment
    // already gives for why it has no fixture-fallback) — unreachable here IS
    // a real incident of its own, mirroring discoverDockerIncidents() below
    // exactly, not just "can't check this source." Deliberately a fulfilled
    // result (not re-thrown): a genuine, successful check that found the
    // container down is real information, and tick()'s pruning below should
    // treat it as such — if a real blocking-query incident was active when
    // the container went down, this fixed id correctly replaces it as the
    // one real problem to report, the same way Docker's single fixed id
    // already works.
    logEvent({
      level: "warn",
      event: "incident_feed_source_check",
      context: { source: "postgres", outcome: "failure", errorClass: error instanceof Error ? error.name : "Error" },
    });
    return [
      {
        id: "postgres:unreachable",
        source: "postgres",
        title: "Postgres (dev-postgres) unreachable",
        detail: "Verify Docker Desktop is running and the dev-postgres container is up (mcp-server/dev-postgres/).",
        severity: "warning",
        occurredAt: new Date().toISOString(),
        sourceMode: "live",
      },
    ];
  }
}

async function pushIncidentNotification(incident: DashboardIncident): Promise<void> {
  try {
    await notifyOperators({
      actionType: "incident report",
      incidentId: incident.id,
      summary: `${incident.title}\n${incident.detail}`,
      // Red-flavored: urgent is the one priority tier with a genuinely red
      // accent in ntfy clients, live-verified against the real configured topic.
      priority: "urgent",
      tags: "rotating_light",
    });
  } catch (error) {
    safeLogEvent("incidentFeedService", {
      level: "error",
      event: "incident_notification_dispatch_failed",
      context: { incidentId: incident.id, errorClass: error instanceof Error ? error.name : "Error" },
    });
  }
}

async function tick(): Promise<void> {
  const SOURCES: IncidentSource[] = ["sql", "ssrs", "cloud", "docker", "postgres"];
  const settled = await Promise.allSettled([
    discoverSqlIncidents(),
    discoverSsrsIncidents(),
    discoverCloudIncidents(),
    discoverDockerIncidents(),
    discoverPostgresIncidents(),
  ]);
  const discovered = settled
    .filter((r): r is PromiseFulfilledResult<DashboardIncident[]> => r.status === "fulfilled")
    .flatMap((r) => r.value);
  const discoveredIds = new Set(discovered.map((incident) => incident.id));
  // Only a source that genuinely checked this tick (fulfilled — see each
  // discover*Incidents()'s catch, which re-throws rather than swallowing into
  // []) can be trusted to say "nothing found here." A rejected source means
  // "couldn't check," not "all clear" — conflating the two below would let a
  // transient SQL Server/SSRS/Cloud/Postgres outage silently prune every one
  // of that source's real active incidents out of the feed.
  const checkedSources = new Set(
    settled.flatMap((r, i) => (r.status === "fulfilled" ? [SOURCES[i]] : []))
  );

  // An active, never-explicitly-resolved incident whose underlying condition
  // clears on its own (a SQL/Postgres lock releases, Superset comes back
  // healthy) must leave the active feed too — not just the human-resolved
  // path markResolved() covers. Found live: a real SQL blocking scenario
  // self-released (confirmed via a direct DMV query showing zero blocked
  // sessions) while the dashboard kept showing it as active indefinitely,
  // holding System Health at "Unhealthy" for a problem that no longer existed.
  // This is a separate, un-notified, un-audited clearing — deliberately NOT
  // added to resolvedIds (that set's suppression semantics are for a human's
  // guardrail-approved fix specifically, per markResolved()'s own doc comment)
  // and NOT rendered in the "Resolved" panel (that panel reads the guardrail
  // audit trail, not this module's state) — it just quietly stops being active.
  for (const [id, tracked] of state) {
    if (checkedSources.has(tracked.incident.source) && !discoveredIds.has(id)) {
      state.delete(id);
      logEvent({
        level: "info",
        event: "incident_naturally_cleared",
        context: { incidentId: id, source: tracked.incident.source },
      });
    }
  }

  // A resolved incident whose underlying condition has since cleared can recur.
  // Most sources' ids are naturally scoped to one occurrence (a specific SSRS
  // run's timestamp, a specific blocking session pair), so this rarely matters
  // for them — but Docker's id (`docker:superset`) has no per-occurrence
  // component, so without this a resolved outage could only ever be detected
  // once per process lifetime, even if Superset goes down again later. Only
  // un-suppress once the id stops being discovered at all; an id still being
  // discovered (the same still-blocking session, an unhealed fixture row)
  // stays suppressed exactly as before.
  for (const id of resolvedIds) {
    if (!discoveredIds.has(id)) {
      resolvedIds.delete(id);
    }
  }

  const now = Date.now();
  for (const incident of discovered) {
    if (resolvedIds.has(incident.id) || state.has(incident.id)) continue;
    state.set(incident.id, {
      incident,
      discoveredAt: now,
      revealAt: now + (isDemoModeEnabled() ? randomRevealDelay() : 0),
      revealed: false,
      notified: false,
    });
  }

  for (const tracked of state.values()) {
    if (!tracked.revealed && now >= tracked.revealAt) {
      tracked.revealed = true;
    }
    if (tracked.revealed && !tracked.notified) {
      tracked.notified = true;
      void pushIncidentNotification(tracked.incident);
    }
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

async function tickIfIdle(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    await tick();
  } finally {
    tickInFlight = false;
  }
}

export function startIncidentFeed(): { stop: () => void } {
  void tickIfIdle();
  intervalHandle = setInterval(() => {
    void tickIfIdle();
  }, POLL_INTERVAL_MS);
  return {
    stop: () => {
      if (intervalHandle) clearInterval(intervalHandle);
      intervalHandle = null;
    },
  };
}

export function getRevealedIncidents(): DashboardIncident[] {
  return Array.from(state.values())
    .filter((tracked) => tracked.revealed)
    .map((tracked) => tracked.incident);
}

// Called once an incident has genuinely been fixed and approved — removes it
// from the active feed and suppresses rediscovery for the life of this process,
// so fixture-backed evidence (which never actually changes on its own) doesn't
// reappear as "new" on the very next tick. In-memory only: a real restart does
// not remember what was resolved before it — an accepted, flagged limitation
// for fixture-backed demo data, not something this pass builds persistence for.
export function markResolved(incidentId: string): void {
  state.delete(incidentId);
  resolvedIds.add(incidentId);
}
