import { AuditLog, buildSystemEventAuditEntry } from "../../../guardrails/auditLog.js";

// ADR-002 (docs/ADR-002-audit-trail-correlation-id-unification.md) step 3: each
// mcp-server/ service that logs an operational event now also writes a
// SystemEventAuditEntry, alongside (not instead of) its existing logEvent()/
// safeLogEvent() call — logEvent() stays the live operational view; AuditLog becomes
// the durable, queryable-by-correlation-ID one. This is the same shape as this
// repo's other injectable options (queryFn, analyzeFn, notifyFn): auditLog is
// optional so a caller/test that doesn't supply one sees no behavior change.
//
// Extracted once, upfront, rather than waiting for a third occurrence (unlike
// safeLogEvent.ts's extraction history) — this call site was always going to appear
// in all five mcp-server/ services ADR-002 names (recommendationService,
// cloudRecommendationService, escalationService, monitoringService,
// notificationService), so writing it five times first would have been pure
// duplication with no discovery value.
export function recordSystemEvent(
  auditLog: AuditLog | undefined,
  actor: string,
  event: string,
  outcome: "success" | "failure",
  context: Record<string, unknown>,
  correlationId: string
): void {
  auditLog?.record(
    buildSystemEventAuditEntry(event, outcome, context, actor, crypto.randomUUID(), correlationId)
  );
}
