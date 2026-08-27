// Enforces R4 (see project-blueprint/requirements.md): a remediation action may only
// proceed to execution if it is evidence-linked, human-approved, and of an allowed,
// reversible action type. Pure and deterministic — no I/O, safe to call on every
// remediation before the execution path is reached.
//
// Audit-completeness (the 4th R4 property) is NOT checked here: it's a property of the
// end-to-end trail (detection -> recommendation -> approval -> execution outcome), which
// this function cannot observe about itself. The caller (execution service) is
// responsible for writing that trail; see remediationGuardrail.test.ts for the contract
// test that documents this split.

// STORY-001 (REQ-001): approval is a decision, not just a presence/absence flag —
// a denied request must be distinguishable from one nobody has reviewed yet, so a
// denial can be resubmitted without silently reading as "already approved." Both
// null (no decision yet) and status: "denied" fail the approval check below.
export interface ApprovalDecision {
  status: "approved" | "denied";
  decidedBy: string;
  decidedAt: string;
  reason?: string;
}

export interface RemediationAction {
  actionType: string;
  evidenceIds: string[];
  approval: ApprovalDecision | null;
  targetSystem: { name: string; productionWriteProtected: boolean };
}

// kill_blocking_session added per docs/ADR-010-sql-remediation-safety.md —
// same reversibility class as the other four: it only rolls back the killed
// session's own uncommitted transaction, touches no committed data, and
// affects no other session. Never offered unconditionally — see
// mcp-server/src/sqlRemediationSafety.ts, which is the actual gate on
// whether killing a given session is safe to propose at all.
export const ALLOWED_ACTION_TYPES = new Set([
  "restart_service",
  "clear_queue",
  "recycle_app_pool",
  "failover_to_replica",
  "kill_blocking_session",
]);

export type GuardrailViolation =
  | "NOT_EVIDENCE_LINKED"
  | "NOT_HUMAN_APPROVED"
  | "ACTION_TYPE_NOT_ALLOWED"
  | "PRODUCTION_WRITE_REQUIRES_APPROVAL";

export interface GuardrailResult {
  allowed: boolean;
  violations: GuardrailViolation[];
}

export function checkRemediationGuardrail(action: RemediationAction): GuardrailResult {
  const violations: GuardrailViolation[] = [];

  if (!action.evidenceIds || action.evidenceIds.length === 0) {
    violations.push("NOT_EVIDENCE_LINKED");
  }
  if (!action.approval || action.approval.status !== "approved") {
    violations.push("NOT_HUMAN_APPROVED");
  }
  if (!ALLOWED_ACTION_TYPES.has(action.actionType)) {
    violations.push("ACTION_TYPE_NOT_ALLOWED");
  }
  if (
    action.targetSystem.productionWriteProtected &&
    (!action.approval || action.approval.status !== "approved")
  ) {
    violations.push("PRODUCTION_WRITE_REQUIRES_APPROVAL");
  }

  return { allowed: violations.length === 0, violations };
}
