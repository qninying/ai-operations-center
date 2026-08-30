import { notifyOperators } from "./notificationService.js";
import { safeLogEvent as sharedSafeLogEvent } from "./observability/safeLogEvent.js";
import { recordSystemEvent } from "./observability/auditWrite.js";
import type { LogEventInput } from "./observability/logger.js";
import type { AuditLog } from "../../guardrails/auditLog.js";
import { readConfidenceThreshold } from "./confidenceThresholds.js";

// STORY-009 / REQ-011: escalate an incident to a human operator when the AI's
// confidence in its own recommendation is below 60%. Source-agnostic by design —
// confidence scores come from analyzeIncidentRootCause() (STORY-003) regardless of
// which path produced the evidence (SQL Server, cloud service, or the monitoring
// loop), so this module takes a confidence score directly rather than depending on
// any one of those paths.
//
// "Notify a human operator" (acceptance criterion 1) was, at STORY-009, a distinct
// logged event only. STORY-010 adds a real dispatched notification (notifyOperators(),
// with its own capped retry) alongside that log — this module still keeps its own
// synchronous, unchanged return type (EscalationRecord | null), so STORY-009's
// existing callers and tests needed no changes.

// REQ-014: configurable via CONFIDENCE_THRESHOLD_ESCALATION — see confidenceThresholds.ts.
const ESCALATION_THRESHOLD = readConfidenceThreshold("CONFIDENCE_THRESHOLD_ESCALATION", 60);

// Found live: dashboard.html's Troubleshoot button re-enables after each call with
// no dedup, so re-clicking it on the same still-active, unchanged incident reruns
// analyzeIncidentRootCause() and, correctly, gets the same confidence/rootCause back
// on unchanged evidence — but this function then unconditionally re-fired a real
// operator notification for that identical conclusion every single time. A real
// violation of this repo's own non-negotiable idempotency rule (side effects gated
// by an idempotency key when the operation is replayable) — the same class of bug
// the SQL/Postgres/Cloud seed scripts' own dedup keys already guard against.
// Deliberately keyed on (confidence, rootCause) content, NOT incidentId — every
// caller mints a fresh incidentId per click (see httpServer.ts's aiIncidentId),
// so keying on it would never collide and the dedup would never fire. rootCause is
// a full natural-language sentence citing specific evidence values (session ids,
// pids, timestamps), so two genuinely different real incidents producing
// byte-identical text is not a realistic collision to worry about. In-memory only,
// same "process-lifetime suppression" precedent as incidentFeedService.ts's own
// resolvedIds set — a restart clears it, which is fine: a fresh process means a
// fresh presenter session, not a rapid-fire re-click storm to guard against.
const notifiedEscalations = new Set<string>();

export interface EscalationRecord {
  incidentId: string;
  confidence: number;
  rootCause: string;
  escalatedAt: string;
}

export class InvalidConfidenceScoreError extends Error {
  readonly errorClass = "InvalidConfidenceScoreError" as const;

  constructor(readonly confidence: unknown) {
    super(
      `Confidence score must be a finite number between 0 and 100; got ${JSON.stringify(confidence)}.`
    );
    this.name = "InvalidConfidenceScoreError";
  }
}

function isValidConfidence(confidence: number): boolean {
  return typeof confidence === "number" && Number.isFinite(confidence) && confidence >= 0 && confidence <= 100;
}

// Same guard STORY-008 established: an escalation whose own logging call throws
// should not be lost or crash the caller — this is the "Escalation log failure"
// failure path made concrete, never a silent re-throw. Extracted to
// observability/safeLogEvent.ts as of STORY-010 (third occurrence of this exact
// guard); this thin wrapper keeps this file's call sites and existing tests unchanged.
function safeLogEvent(input: LogEventInput): void {
  sharedSafeLogEvent("escalationService", input);
}

export interface EvaluateEscalationOptions {
  // STORY-010: injection point for tests. Defaults to the real notifyOperators().
  notifyFn?: typeof notifyOperators;
  // ADR-002 step 3: incidentId already IS the correlation ID for every call site
  // this function has today (all HTTP-triggered, generated once in httpServer.ts).
  auditLog?: AuditLog;
}

// Returns the EscalationRecord when confidence is below the threshold, or null when
// it isn't — a null return is the correct, honest "not escalated" outcome, not a
// missing case. Throws InvalidConfidenceScoreError for a malformed score rather than
// silently treating it as either escalated or not.
export function evaluateEscalation(
  incidentId: string,
  confidence: number,
  rootCause: string,
  options: EvaluateEscalationOptions = {}
): EscalationRecord | null {
  if (!isValidConfidence(confidence)) {
    throw new InvalidConfidenceScoreError(confidence);
  }

  if (confidence >= ESCALATION_THRESHOLD) {
    return null;
  }

  const record: EscalationRecord = {
    incidentId,
    confidence,
    rootCause,
    escalatedAt: new Date().toISOString(),
  };

  safeLogEvent({
    level: "warn",
    event: "escalation_triggered",
    context: {
      incidentId,
      confidence,
      rootCause,
      escalatedAt: record.escalatedAt,
      notifiedOperator: true,
    },
  });
  recordSystemEvent(
    options.auditLog,
    "escalationService",
    "escalation_triggered",
    "success",
    { confidence, rootCause, escalatedAt: record.escalatedAt },
    incidentId
  );

  // STORY-010 / REQ-012: an escalation is this system's other real autonomous action.
  // Fire-and-forget, same reasoning as monitoringService.ts — evaluateEscalation()
  // stays synchronous (its established contract from STORY-009), and
  // notifyOperators()'s own capped retry shouldn't block this function's return.
  const dedupeKey = `${confidence}::${rootCause}`;
  if (notifiedEscalations.has(dedupeKey)) {
    safeLogEvent({
      level: "info",
      event: "escalation_notification_deduped",
      context: { incidentId, confidence },
    });
  } else {
    notifiedEscalations.add(dedupeKey);
    const notifyFn = options.notifyFn ?? notifyOperators;
    notifyFn(
      {
        actionType: "escalation",
        incidentId,
        summary: rootCause,
        // Yellow-flavored: a step down from a fresh incident's urgent/red, still
        // visibly elevated (unlike the green, no-accent auth-code notification).
        priority: "high",
        tags: "warning",
      },
      { auditLog: options.auditLog }
    ).catch((error) => {
      safeLogEvent({
        level: "error",
        event: "operator_notification_dispatch_failed",
        context: { incidentId, errorClass: error instanceof Error ? error.name : "Error" },
      });
    });
  }

  return record;
}
