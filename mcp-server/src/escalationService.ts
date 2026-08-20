import { notifyOperators } from "./notificationService.js";
import { safeLogEvent as sharedSafeLogEvent } from "./observability/safeLogEvent.js";
import type { LogEventInput } from "./observability/logger.js";

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

const ESCALATION_THRESHOLD = 60;

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

  // STORY-010 / REQ-012: an escalation is this system's other real autonomous action.
  // Fire-and-forget, same reasoning as monitoringService.ts — evaluateEscalation()
  // stays synchronous (its established contract from STORY-009), and
  // notifyOperators()'s own capped retry shouldn't block this function's return.
  const notifyFn = options.notifyFn ?? notifyOperators;
  notifyFn({
    actionType: "escalation",
    incidentId,
    summary: rootCause,
  }).catch((error) => {
    safeLogEvent({
      level: "error",
      event: "operator_notification_dispatch_failed",
      context: { incidentId, errorClass: error instanceof Error ? error.name : "Error" },
    });
  });

  return record;
}
