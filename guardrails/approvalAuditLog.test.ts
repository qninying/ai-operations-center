import { describe, it, expect } from "vitest";
import { ApprovalAuditLog, buildApprovalAuditEntry } from "./approvalAuditLog.js";
import { RemediationAction } from "./remediationGuardrail.js";

function baseAction(overrides: Partial<RemediationAction> = {}): RemediationAction {
  return {
    actionType: "restart_service",
    evidenceIds: ["evt-4471"],
    approval: null,
    targetSystem: { name: "prod-app-server-03", productionWriteProtected: true },
    ...overrides,
  };
}

describe("ApprovalAuditLog (STORY-001 criterion 3: every approval decision is logged)", () => {
  it("logs an approval decision", () => {
    const log = new ApprovalAuditLog();
    const entry = buildApprovalAuditEntry(
      baseAction(),
      { status: "approved", decidedBy: "jsmith", decidedAt: "2026-08-18T12:00:00Z" },
      "corr-1",
      () => "2026-08-18T12:00:01Z"
    );

    log.record(entry);

    expect(log.all()).toEqual([entry]);
  });

  it("logs a denial decision distinctly from an approval", () => {
    const log = new ApprovalAuditLog();
    const denial = buildApprovalAuditEntry(
      baseAction(),
      { status: "denied", decidedBy: "jsmith", decidedAt: "2026-08-18T12:00:00Z", reason: "insufficient evidence" },
      "corr-2",
      () => "2026-08-18T12:00:01Z"
    );

    log.record(denial);

    expect(log.all()[0].decision.status).toBe("denied");
    expect(log.all()[0].decision.reason).toBe("insufficient evidence");
  });

  it("is idempotent: recording the identical decision event twice does not duplicate the trail", () => {
    const log = new ApprovalAuditLog();
    const entry = buildApprovalAuditEntry(
      baseAction(),
      { status: "denied", decidedBy: "jsmith", decidedAt: "2026-08-18T12:00:00Z" },
      "corr-3",
      () => "2026-08-18T12:00:01Z"
    );

    log.record(entry);
    log.record(entry); // simulates a retried webhook / resubmitted denial

    expect(log.all().length).toBe(1);
  });

  it("does not dedup two distinct decisions that share a correlation ID (e.g. a denial later reversed into an approval)", () => {
    const log = new ApprovalAuditLog();
    const denial = buildApprovalAuditEntry(
      baseAction(),
      { status: "denied", decidedBy: "jsmith", decidedAt: "2026-08-18T12:00:00Z" },
      "corr-4",
      () => "2026-08-18T12:00:01Z"
    );
    const laterApproval = buildApprovalAuditEntry(
      baseAction(),
      { status: "approved", decidedBy: "jsmith", decidedAt: "2026-08-18T13:00:00Z" },
      "corr-4",
      () => "2026-08-18T13:00:01Z"
    );

    log.record(denial);
    log.record(laterApproval);

    expect(log.all().length).toBe(2);
  });

  it("filters entries by correlation ID", () => {
    const log = new ApprovalAuditLog();
    const entryA = buildApprovalAuditEntry(
      baseAction(),
      { status: "approved", decidedBy: "jsmith", decidedAt: "2026-08-18T12:00:00Z" },
      "corr-a",
      () => "2026-08-18T12:00:01Z"
    );
    const entryB = buildApprovalAuditEntry(
      baseAction(),
      { status: "denied", decidedBy: "rjones", decidedAt: "2026-08-18T12:05:00Z" },
      "corr-b",
      () => "2026-08-18T12:05:01Z"
    );

    log.record(entryA);
    log.record(entryB);

    expect(log.forCorrelationId("corr-a")).toEqual([entryA]);
  });
});
