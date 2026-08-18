// STORY-001 (REQ-001), criterion 3: "every approval decision is logged for audit."
// Deliberately separate from remediationGuardrail.ts, which stays a pure decision
// function per R4's header comment — this module is the "caller" responsibility
// that comment names: recording an approval/denial decision once it's made, not
// re-deriving the guardrail's allowed/violations result.
//
// This does not implement R4 property 4 in full (the end-to-end detection ->
// recommendation -> approval -> execution-outcome trail) — only the
// approval-decision slice STORY-001 scopes. The rest stays the execution
// service's responsibility once one exists, same as R4's header already says.

import { ApprovalDecision, RemediationAction } from "./remediationGuardrail.js";

export interface ApprovalAuditEntry {
  correlationId: string;
  actionType: string;
  targetSystem: string;
  decision: ApprovalDecision;
  loggedAt: string;
}

export function buildApprovalAuditEntry(
  action: RemediationAction,
  decision: ApprovalDecision,
  correlationId: string,
  now: () => string = () => new Date().toISOString()
): ApprovalAuditEntry {
  return {
    correlationId,
    actionType: action.actionType,
    targetSystem: action.targetSystem.name,
    decision,
    loggedAt: now(),
  };
}

function isSameDecisionEvent(a: ApprovalAuditEntry, b: ApprovalAuditEntry): boolean {
  return (
    a.correlationId === b.correlationId &&
    a.decision.status === b.decision.status &&
    a.decision.decidedBy === b.decision.decidedBy &&
    a.decision.decidedAt === b.decision.decidedAt
  );
}

// In-memory, append-only log. Idempotent by construction (see CLAUDE.md's
// Idempotency & Replayability section): recording the identical decision event
// twice — e.g. a retried webhook, a double-submitted form — must not duplicate
// the audit trail. Persistence backing this with real storage is later,
// out-of-scope work; the dedup contract is what matters for this story.
export class ApprovalAuditLog {
  private entries: ApprovalAuditEntry[] = [];

  record(entry: ApprovalAuditEntry): void {
    if (this.entries.some((existing) => isSameDecisionEvent(existing, entry))) {
      return;
    }
    this.entries.push(entry);
  }

  all(): ReadonlyArray<ApprovalAuditEntry> {
    return this.entries;
  }

  forCorrelationId(correlationId: string): ReadonlyArray<ApprovalAuditEntry> {
    return this.entries.filter((entry) => entry.correlationId === correlationId);
  }
}
