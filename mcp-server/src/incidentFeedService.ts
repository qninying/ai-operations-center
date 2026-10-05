import { getConnectors, discoverWithTimeout, ConnectorTimeoutError } from "./connectors/index.js";
import { recordCheckFailure, errorDetails } from "./connectors/sourceCheck.js";
import type { DashboardIncident } from "./connectors/types.js";
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

// The incident shape and source types now live with the connector contract
// (connectors/types.ts, REQ-018). Re-exported so existing imports keep working.
export type { DashboardIncident, IncidentSeverity, IncidentSource } from "./connectors/types.js";

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

// Each data source is a plug-in connector (connectors/, REQ-018 / ADR-016).
// Every connector logs and records its own check; this feed only orchestrates.

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
      context: { incidentId: incident.id, ...errorDetails(error) },
    });
  }
}

async function tick(): Promise<void> {
  const connectors = getConnectors();
  const settled = await Promise.allSettled(connectors.map((connector) => discoverWithTimeout(connector)));
  // A hung connector never got to log its own failure; record it here so the
  // log and GET /health/dependencies still show it as a failed check.
  settled.forEach((r, i) => {
    if (r.status === "rejected" && r.reason instanceof ConnectorTimeoutError) {
      recordCheckFailure(connectors[i], r.reason);
    }
  });
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
    settled.flatMap((r, i) => (r.status === "fulfilled" ? [connectors[i].id] : []))
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
