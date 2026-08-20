// ABAC policy file — generalizes STORY-001's approval gate (see remediationGuardrail.ts,
// scoped specifically to remediation actions) to any actor/resource/action/context
// combination in CoreOps: viewing incident detail, editing the Service Dependency Map,
// approving a fix, or the Execution Service actually running one. Not tied to any
// platform STORY id (no REQ in .colaberry/plan.json covers general ABAC yet) — pure
// supplementary capability, additive to what STORY-001/002 already ship.
//
// Data only. See abacEvaluator.ts for the pure function that reads it.

export type Role = "engineer" | "executive" | "approver" | "auditor" | "orchestrator" | "execution_service";
export type ResourceType =
  | "incident_detail"
  | "incident_summary"
  | "draft_remediation"
  | "live_execution"
  | "dependency_map"
  | "audit_log";
export type Action = "view" | "approve" | "reject" | "request_execution" | "execute" | "edit";
export type RiskLevel = "low" | "medium" | "high";
export type Effect = "allow" | "deny" | "require_approval";

export interface PolicyContext {
  actorType?: "human" | "system";
  approved?: boolean;
  environment?: "production" | "test";
  [key: string]: unknown;
}

export interface AbacRequest {
  role: Role;
  resourceType: ResourceType;
  action: Action;
  context?: PolicyContext;
}

export interface PolicyRule {
  id: string;
  description: string;
  when: {
    role?: Role;
    resourceType?: ResourceType;
    action?: Action;
    context?: PolicyContext;
  };
  riskLevel: RiskLevel;
  effect: Effect;
}

export interface AbacPolicy {
  version: string;
  defaultEffect: Effect;
  rules: PolicyRule[];
}

export const ABAC_POLICY: AbacPolicy = {
  version: "1.0",
  defaultEffect: "deny",
  rules: [
    {
      id: "engineer-view-technical-detail",
      description: "Engineers can view full technical incident detail.",
      when: { role: "engineer", resourceType: "incident_detail", action: "view" },
      riskLevel: "low",
      effect: "allow",
    },
    {
      id: "executive-view-summary",
      description: "Executives can view the plain-English incident summary.",
      when: { role: "executive", resourceType: "incident_summary", action: "view" },
      riskLevel: "low",
      effect: "allow",
    },
    {
      id: "executive-cannot-view-technical-detail",
      description: "Executives are not the audience for raw technical detail.",
      when: { role: "executive", resourceType: "incident_detail", action: "view" },
      riskLevel: "medium",
      effect: "deny",
    },
    {
      id: "approver-view-draft-remediation",
      description: "Approvers can view a proposed fix before deciding on it.",
      when: { role: "approver", resourceType: "draft_remediation", action: "view" },
      riskLevel: "medium",
      effect: "allow",
    },
    {
      id: "orchestrator-request-execution-requires-approval",
      description:
        "The AI Orchestrator may request execution of a diagnosed remediation, but this always requires a recorded human approval before anything runs.",
      when: { role: "orchestrator", resourceType: "live_execution", action: "request_execution" },
      riskLevel: "high",
      effect: "require_approval",
    },
    {
      id: "no-human-executes-directly",
      description:
        "No human role may directly execute a live action against a monitored server -- execution is a system action, gated on a recorded approval. See remediationGuardrail.ts for the deeper, content-level check (evidence/approval/action-type) applied once execution is actually attempted.",
      when: { resourceType: "live_execution", action: "execute", context: { actorType: "human" } },
      riskLevel: "high",
      effect: "deny",
    },
    {
      id: "system-executes-after-recorded-approval",
      description:
        "The Execution Service (a system actor, never a human) may request to execute a remediation only after a HITL approval has been recorded for it. checkRemediationGuardrail() still applies on top of this as the content-level gate.",
      when: { resourceType: "live_execution", action: "execute", context: { actorType: "system", approved: true } },
      riskLevel: "high",
      effect: "allow",
    },
    {
      id: "engineer-edit-dependency-map",
      description: "Engineers can update the Service Dependency Map (ops-maintained config), logged.",
      when: { role: "engineer", resourceType: "dependency_map", action: "edit" },
      riskLevel: "medium",
      effect: "allow",
    },
    {
      id: "auditor-view-audit-log",
      description: "Read-only auditors can view the audit log but never anything else.",
      when: { role: "auditor", resourceType: "audit_log", action: "view" },
      riskLevel: "low",
      effect: "allow",
    },
  ],
};
