import { queryLiveDmv } from "./dmvLiveSource.js";
import type { DmvExecRequestRow } from "./dmvFixtures.js";
import { logEvent, type LogEventInput } from "./observability/logger.js";

// STORY-008 / REQ-016: continuous monitoring for incident management. Calls
// queryLiveDmv() directly, the same as recommendationService.ts and
// cloudRecommendationService.ts — never dmvReader.ts's fixture-fallback path.
// Presenting a fixture-derived "incident" (or "all clear") as a real, continuous
// monitoring result would be exactly the fabrication those stories were built to
// refuse; a genuinely unreachable server here surfaces as a logged monitoring
// failure, not a silent substitution.
//
// "A server" in this story's acceptance criteria is deliberately read as the one
// real, already-connected system this repo can actually reach (the live Azure SQL
// Database from STORY-006) rather than a new, uncredentialed Windows Server
// connection — flagged and confirmed with the user before building.
//
// Incident detection reuses STORY-006's already-fixed, already-tested query as-is
// (any row with a non-zero blocking_session_id is a real blocking incident) rather
// than adding new detection logic that could reintroduce that bug's class of error.

const DEFAULT_INTERVAL_MS = 10_000;

export interface MonitoringCycleResult {
  timestamp: string;
  outcome: "success" | "failure";
  incidentDetected: boolean;
  rowCount?: number;
  errorClass?: string;
  alert?: {
    sessionId: number;
    blockingSessionId: number;
    databaseName: string;
  };
}

export interface MonitoringOptions {
  intervalMs?: number;
  queryFn?: typeof queryLiveDmv;
  // Fires after every cycle (success or failure), in addition to logEvent — this is
  // for a caller that wants to surface live status (e.g. an HTTP status route); it is
  // never the audit trail itself, logEvent remains that.
  onCycle?: (result: MonitoringCycleResult) => void;
}

export interface MonitoringHandle {
  stop: () => void;
}

function hasIncident(rows: DmvExecRequestRow[]): DmvExecRequestRow | undefined {
  return rows.find((row) => row.blocking_session_id !== 0);
}

// A monitoring loop that dies because its own logging call threw would be worse than
// one that occasionally fails to log — this is the last line of defense for the
// "Monitoring log failure" path, deliberately never re-throwing.
function safeLogEvent(input: LogEventInput): void {
  try {
    logEvent(input);
  } catch (error) {
    try {
      console.error("monitoringService: logEvent failed", error);
    } catch {
      // Truly nothing more can be done here; never let a log failure escape the loop.
    }
  }
}

async function runMonitoringCycle(
  queryFn: typeof queryLiveDmv,
  onCycle?: (result: MonitoringCycleResult) => void
): Promise<void> {
  let rows: DmvExecRequestRow[];
  try {
    rows = await queryFn({ dmvName: "sys.dm_exec_requests" });
  } catch (error) {
    const errorClass = error instanceof Error ? error.name : "Error";
    safeLogEvent({
      level: "error",
      event: "monitoring_cycle",
      context: { outcome: "failure", errorClass },
    });
    onCycle?.({
      timestamp: new Date().toISOString(),
      outcome: "failure",
      incidentDetected: false,
      errorClass,
    });
    return;
  }

  const incident = hasIncident(rows);
  safeLogEvent({
    level: "info",
    event: "monitoring_cycle",
    context: { outcome: "success", incidentDetected: incident !== undefined, rowCount: rows.length },
  });

  if (incident) {
    safeLogEvent({
      level: "warn",
      event: "incident_alert",
      context: {
        source: "sys.dm_exec_requests",
        sessionId: incident.session_id,
        blockingSessionId: incident.blocking_session_id,
        databaseName: incident.database_name,
      },
    });
  }

  onCycle?.({
    timestamp: new Date().toISOString(),
    outcome: "success",
    incidentDetected: incident !== undefined,
    rowCount: rows.length,
    alert: incident
      ? {
          sessionId: incident.session_id,
          blockingSessionId: incident.blocking_session_id,
          databaseName: incident.database_name,
        }
      : undefined,
  });
}

// Runs the first cycle immediately (continuous monitoring shouldn't mean silence for
// the first intervalMs), then on the given interval until stop() is called. A failed
// cycle never stops the loop — it's logged and the next interval tick proceeds
// normally, which is what makes "continuous" true rather than aspirational.
//
// Guards against overlapping cycles: if a cycle is still in flight when the next
// interval tick fires (a real, live-observed case — a cold-starting Azure SQL free
// tier instance took ~30s to respond against a 10s interval), the tick is skipped
// rather than firing a second concurrent queryLiveDmv() call. Without this, multiple
// concurrent connection attempts against an already-struggling server can pile up
// failures fast enough to trip the shared circuit breaker on a false alarm — the
// server would have come up fine on a single retry sequence.
export function startMonitoring(options: MonitoringOptions = {}): MonitoringHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const queryFn = options.queryFn ?? queryLiveDmv;

  let cycleInFlight = false;
  async function runIfIdle(): Promise<void> {
    if (cycleInFlight) {
      return;
    }
    cycleInFlight = true;
    try {
      await runMonitoringCycle(queryFn, options.onCycle);
    } finally {
      cycleInFlight = false;
    }
  }

  void runIfIdle();
  const timer = setInterval(() => {
    void runIfIdle();
  }, intervalMs);

  return {
    stop: () => clearInterval(timer),
  };
}
