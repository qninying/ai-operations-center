import { describe, it, expect } from "vitest";
import { checkRemediationGuardrail, RemediationAction } from "./remediationGuardrail.js";

function baseAction(overrides: Partial<RemediationAction> = {}): RemediationAction {
  return {
    actionType: "restart_service",
    evidenceIds: ["evt-123"],
    approval: { approvedBy: "jsmith", approvedAt: "2026-08-07T12:00:00Z" },
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

  it("rejects an action type outside the allowed remediation list", () => {
    const result = checkRemediationGuardrail(baseAction({ actionType: "drop_database" }));
    expect(result.allowed).toBe(false);
    expect(result.violations).toContain("ACTION_TYPE_NOT_ALLOWED");
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
