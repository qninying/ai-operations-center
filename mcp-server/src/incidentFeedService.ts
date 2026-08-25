import { readDmv } from "./dmvReader.js";
import { readSsrsExecutionLog } from "./ssrsReader.js";
import { queryLiveCloudBlob } from "./cloudBlobSource.js";
import { checkSupersetHealth } from "./supersetHealthSource.js";
import { notifyOperators } from "./notificationService.js";
import { isDemoModeEnabled } from "./demoModeGate.js";
import { logEvent } from "./observability/logger.js";
import { safeLogEvent } from "./observability/safeLogEvent.js";

// Unified, multi-source incident feed: SQL Server (DMV blocking chains), Cloud
// (Blob diagnostics), SSRS (ExecutionLog3), and Docker (the dev-superset stack's
// own health) all surface into one list, instead of the dashboard making the
// user pick a single source before it shows anything. Only genuine problems
// count as incidents — a source being unreachable means "can't check this
// source" (logged, not fabricated as a finding), except Docker, where
// unreachable IS the incident: there's nothing else to check for that source.
//
// Staged reveal is a deliberate, demo-mode-only choice, not baked into "what
// counts as an incident": every discovered incident gets a revealAt timestamp
// (now, in a real deployment; now + a random 3-45s delay in demo mode) assigned
// ONCE, by this background loop — never by a client. That's what keeps the
// reveal and its accompanying ntfy push idempotent and reload-proof: any number
// of browser tabs polling GET /api/incidents at any time all see the exact same
// revealed/not-yet-revealed state, and the push for a given incident fires
// exactly once, from here, regardless of how many times a client reloads.

export type IncidentSource = "sql" | "cloud" | "ssrs" | "docker";
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
    return [];
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
    return [];
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
    return [];
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
  const [sql, ssrs, cloud, docker] = await Promise.allSettled([
    discoverSqlIncidents(),
    discoverSsrsIncidents(),
    discoverCloudIncidents(),
    discoverDockerIncidents(),
  ]);
  const discovered = [sql, ssrs, cloud, docker]
    .filter((r): r is PromiseFulfilledResult<DashboardIncident[]> => r.status === "fulfilled")
    .flatMap((r) => r.value);

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
