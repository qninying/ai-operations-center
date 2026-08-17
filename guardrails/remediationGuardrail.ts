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

export interface RemediationAction {
  actionType: string;
  evidenceIds: string[];
  approval: { approvedBy: string; approvedAt: string } | null;
  targetSystem: { name: string; productionWriteProtected: boolean };
}

export const ALLOWED_ACTION_TYPES = new Set([
  "restart_service",
  "clear_queue",
  "recycle_app_pool",
  "failover_to_replica",
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
  if (!action.approval) {
    violations.push("NOT_HUMAN_APPROVED");
  }
  if (!ALLOWED_ACTION_TYPES.has(action.actionType)) {
    violations.push("ACTION_TYPE_NOT_ALLOWED");
  }
  if (action.targetSystem.productionWriteProtected && !action.approval) {
    violations.push("PRODUCTION_WRITE_REQUIRES_APPROVAL");
  }

  return { allowed: violations.length === 0, violations };
}
