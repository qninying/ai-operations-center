import { logEvent, type LogEventInput } from "./observability/logger.js";

// STORY-009 / REQ-011: escalate an incident to a human operator when the AI's
// confidence in its own recommendation is below 60%. Source-agnostic by design —
// confidence scores come from analyzeIncidentRootCause() (STORY-003) regardless of
// which path produced the evidence (SQL Server, cloud service, or the monitoring
// loop), so this module takes a confidence score directly rather than depending on
// any one of those paths.
//
// "Notify a human operator" (acceptance criterion 1) is, at this stage of the build,
// a distinct, real logged event — the same walking-skeleton meaning STORY-008 gave
// "alert." A paging/email notification channel is explicitly STORY-010's job, not
// this one; building it here would be building something this story wasn't asked for.

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
// failure path made concrete, never a silent re-throw.
function safeLogEvent(input: LogEventInput): void {
  try {
    logEvent(input);
  } catch (error) {
    try {
      console.error("escalationService: logEvent failed", error);
    } catch {
      // Truly nothing more can be done here; never let a log failure escape.
    }
  }
}

// Returns the EscalationRecord when confidence is below the threshold, or null when
// it isn't — a null return is the correct, honest "not escalated" outcome, not a
// missing case. Throws InvalidConfidenceScoreError for a malformed score rather than
// silently treating it as either escalated or not.
export function evaluateEscalation(
  incidentId: string,
  confidence: number,
  rootCause: string
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

  return record;
}
