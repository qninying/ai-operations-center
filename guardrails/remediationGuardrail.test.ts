import { describe, it, expect } from "vitest";
import { checkRemediationGuardrail, RemediationAction, ALLOWED_ACTION_TYPES } from "./remediationGuardrail.js";

function baseAction(overrides: Partial<RemediationAction> = {}): RemediationAction {
  return {
    actionType: "restart_service",
    evidenceIds: ["evt-123"],
    approval: { status: "approved", decidedBy: "jsmith", decidedAt: "2026-08-07T12:00:00Z" },
    targetSystem: { name: "app-server-01", productionWriteProtected: false },
    ...overrides,
  };
}

describe("checkRemediationGuardrail", () => {
  it("allows an evidence-linked, approved, in-scope action (happy path)", () => {
    const result = checkRemediationGuardrail(baseAction());
    expect(result).toEqual({ allowed: true, violations: [] });
  });

  it("rejects an action with no evidence", () => {
    const result = checkRemediationGuardrail(baseAction({ evidenceIds: [] }));
    expect(result.allowed).toBe(false);
    expect(result.violations).toContain("NOT_EVIDENCE_LINKED");
  });

  it("rejects an unapproved action", () => {
    const result = checkRemediationGuardrail(baseAction({ approval: null }));
    expect(result.allowed).toBe(false);
    expect(result.violations).toContain("NOT_HUMAN_APPROVED");
  });

  it("rejects a denied approval the same as no approval (STORY-001: a denial is not silently treated as clearance)", () => {
    const result = checkRemediationGuardrail(
      baseAction({
        approval: { status: "denied", decidedBy: "jsmith", decidedAt: "2026-08-07T12:00:00Z", reason: "not reversible enough" },
      })
    );
    expect(result.allowed).toBe(false);
    expect(result.violations).toContain("NOT_HUMAN_APPROVED");
  });

  it("still requires approval when a denied action is resubmitted unchanged (STORY-001 criterion 2)", () => {
    const denied = baseAction({
      approval: { status: "denied", decidedBy: "jsmith", decidedAt: "2026-08-07T12:00:00Z" },
    });
    const firstSubmission = checkRemediationGuardrail(denied);
    const resubmission = checkRemediationGuardrail(denied);
    expect(firstSubmission).toEqual(resubmission);
    expect(resubmission.allowed).toBe(false);
    expect(resubmission.violations).toContain("NOT_HUMAN_APPROVED");
  });

  it("rejects an action type outside the allowed remediation list", () => {
    const result = checkRemediationGuardrail(baseAction({ actionType: "drop_database" }));
    expect(result.allowed).toBe(false);
    expect(result.violations).toContain("ACTION_TYPE_NOT_ALLOWED");
  });

  it("ADR-010: allows kill_blocking_session — same reversibility class as the original four, deliberately added", () => {
    const result = checkRemediationGuardrail(baseAction({ actionType: "kill_blocking_session" }));
    expect(result).toEqual({ allowed: true, violations: [] });
  });

  it("ADR-013: allows kill_postgres_backend — same reversibility argument, translated to Postgres", () => {
    const result = checkRemediationGuardrail(baseAction({ actionType: "kill_postgres_backend" }));
    expect(result).toEqual({ allowed: true, violations: [] });
  });

  it("the original four action types are still allowed, unaffected by the ADR-010/ADR-013 additions", () => {
    for (const actionType of ["restart_service", "clear_queue", "recycle_app_pool", "failover_to_replica"]) {
      expect(ALLOWED_ACTION_TYPES.has(actionType)).toBe(true);
    }
    expect(ALLOWED_ACTION_TYPES.size).toBe(6);
  });

  it("rejects an unapproved action against a production-write-protected system with both violations", () => {
    const result = checkRemediationGuardrail(
      baseAction({
        approval: null,
        targetSystem: { name: "prod-db-01", productionWriteProtected: true },
      })
    );
    expect(result.allowed).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining(["NOT_HUMAN_APPROVED", "PRODUCTION_WRITE_REQUIRES_APPROVAL"])
    );
  });

  it("allows an approved action against a production-write-protected system (boundary)", () => {
    const result = checkRemediationGuardrail(
      baseAction({
        targetSystem: { name: "prod-db-01", productionWriteProtected: true },
      })
    );
    expect(result).toEqual({ allowed: true, violations: [] });
  });

  it("reports every simultaneous violation, not just the first", () => {
    const result = checkRemediationGuardrail(
      baseAction({
        evidenceIds: [],
        approval: null,
        actionType: "drop_database",
      })
    );
    expect(result.allowed).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        "NOT_EVIDENCE_LINKED",
        "NOT_HUMAN_APPROVED",
        "ACTION_TYPE_NOT_ALLOWED",
      ])
    );
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });

  it("is pure: identical input twice yields identical, unmutated output", () => {
    const action = baseAction();
    const snapshot = JSON.parse(JSON.stringify(action));

    const first = checkRemediationGuardrail(action);
    const second = checkRemediationGuardrail(action);

    expect(first).toEqual(second);
    expect(action).toEqual(snapshot);
  });
});
