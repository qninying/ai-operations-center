import { describe, it, expect } from "vitest";
import {
  AuditLog,
  AuditLogConflictError,
  AuditLogValidationError,
  buildActionAuditEntry,
  buildDecisionAuditEntry,
} from "./auditLog.js";
import { checkRemediationGuardrail, RemediationAction } from "./remediationGuardrail.js";

function baseAction(overrides: Partial<RemediationAction> = {}): RemediationAction {
  return {
    actionType: "restart_service",
    evidenceIds: ["evt-4471"],
    approval: null,
    targetSystem: { name: "prod-app-server-03", productionWriteProtected: true },
    ...overrides,
  };
}

describe("AuditLog — STORY-001 (decisions)", () => {
  it("logs an approval decision", () => {
    const log = new AuditLog();
    const entry = buildDecisionAuditEntry(
      baseAction(),
      { status: "approved", decidedBy: "jsmith", decidedAt: "2026-08-18T12:00:00Z" },
      "entry-1",
      "corr-1",
      () => "2026-08-18T12:00:01Z"
    );

    log.record(entry);

    expect(log.all()).toEqual([entry]);
  });

  it("logs a denial decision distinctly from an approval", () => {
    const log = new AuditLog();
    const denial = buildDecisionAuditEntry(
      baseAction(),
      { status: "denied", decidedBy: "jsmith", decidedAt: "2026-08-18T12:00:00Z", reason: "insufficient evidence" },
      "entry-2",
      "corr-2",
      () => "2026-08-18T12:00:01Z"
    );

    log.record(denial);

    const stored = log.all()[0] as import("./auditLog.js").DecisionAuditEntry;
    expect(stored.decision.status).toBe("denied");
    expect(stored.decision.reason).toBe("insufficient evidence");
  });

  it("is idempotent: recording the identical entry twice (same id, same content) does not duplicate the trail", () => {
    const log = new AuditLog();
    const entry = buildDecisionAuditEntry(
      baseAction(),
      { status: "denied", decidedBy: "jsmith", decidedAt: "2026-08-18T12:00:00Z" },
      "entry-3",
      "corr-3",
      () => "2026-08-18T12:00:01Z"
    );

    log.record(entry); // e.g. a retried webhook / resubmitted denial
    log.record(entry);

    expect(log.all().length).toBe(1);
  });

  it("filters entries by correlation ID", () => {
    const log = new AuditLog();
    const entryA = buildDecisionAuditEntry(
      baseAction(),
      { status: "approved", decidedBy: "jsmith", decidedAt: "2026-08-18T12:00:00Z" },
      "entry-a",
      "corr-a",
      () => "2026-08-18T12:00:01Z"
    );
    const entryB = buildDecisionAuditEntry(
      baseAction(),
      { status: "denied", decidedBy: "rjones", decidedAt: "2026-08-18T12:05:00Z" },
      "entry-b",
      "corr-b",
      () => "2026-08-18T12:05:01Z"
    );

    log.record(entryA);
    log.record(entryB);

    expect(log.forCorrelationId("corr-a")).toEqual([entryA]);
  });
});

describe("AuditLog — STORY-002 criterion 1: an action, once logged, is retrievable", () => {
  it("logs an executed action and retrieves it by id", () => {
    const log = new AuditLog();
    const action = baseAction({ approval: { status: "approved", decidedBy: "jsmith", decidedAt: "2026-08-18T12:00:00Z" } });
    const result = checkRemediationGuardrail(action);
    const entry = buildActionAuditEntry(action, result, "execution-service", "entry-4", "corr-4", () => "2026-08-18T12:00:02Z");

    log.record(entry);
    const retrieved = log.retrieve("entry-4");

    expect(retrieved).toEqual({ found: true, entry });
    expect((retrieved as { found: true; entry: typeof entry }).entry.outcome).toBe("executed");
  });

  it("logs a blocked action with its violations", () => {
    const log = new AuditLog();
    const action = baseAction();
    const result = checkRemediationGuardrail(action);
    const entry = buildActionAuditEntry(action, result, "execution-service", "entry-5", "corr-5", () => "2026-08-18T12:00:02Z");

    log.record(entry);

    const retrieved = log.retrieve("entry-5");
    expect(retrieved.found).toBe(true);
    if (retrieved.found && retrieved.entry.entryType === "action") {
      expect(retrieved.entry.outcome).toBe("blocked");
      expect(retrieved.entry.violations.length).toBeGreaterThan(0);
    } else {
      throw new Error("expected a found action entry");
    }
  });

  it("failure path — log entry missing: retrieving an id that was never logged returns an explicit not-found result, not undefined", () => {
    const log = new AuditLog();
    const retrieved = log.retrieve("never-logged");
    expect(retrieved).toEqual({ found: false });
  });
});

describe("AuditLog — STORY-002 criterion 2: every logged entry includes its decision maker / actor", () => {
  it("a decision entry's actor is the human who decided", () => {
    const entry = buildDecisionAuditEntry(
      baseAction(),
      { status: "approved", decidedBy: "jsmith", decidedAt: "2026-08-18T12:00:00Z" },
      "entry-6",
      "corr-6"
    );
    expect(entry.actor).toBe("jsmith");
  });

  it("an action entry's actor is whoever/whatever triggered the action", () => {
    const action = baseAction();
    const result = checkRemediationGuardrail(action);
    const entry = buildActionAuditEntry(action, result, "execution-service", "entry-7", "corr-7");
    expect(entry.actor).toBe("execution-service");
  });

  it("failure path — log entry incorrect: an entry missing a required field (actor) is rejected at write time, not silently accepted", () => {
    const log = new AuditLog();
    const action = baseAction();
    const result = checkRemediationGuardrail(action);
    const entry = buildActionAuditEntry(action, result, "", "entry-8", "corr-8");

    expect(() => log.record(entry)).toThrow(AuditLogValidationError);
    expect(log.all().length).toBe(0);
  });
});

describe("AuditLog — STORY-002 criterion 3 (Trust): every log entry is timestamped and immutable", () => {
  it("every entry carries a loggedAt timestamp", () => {
    const entry = buildDecisionAuditEntry(
      baseAction(),
      { status: "approved", decidedBy: "jsmith", decidedAt: "2026-08-18T12:00:00Z" },
      "entry-9",
      "corr-9",
      () => "2026-08-18T12:00:03Z"
    );
    expect(entry.loggedAt).toBe("2026-08-18T12:00:03Z");
  });

  it("a stored entry is frozen — mutating the returned reference does not change what's stored", () => {
    const log = new AuditLog();
    const entry = buildDecisionAuditEntry(
      baseAction(),
      { status: "approved", decidedBy: "jsmith", decidedAt: "2026-08-18T12:00:00Z" },
      "entry-10",
      "corr-10"
    );
    log.record(entry);

    const stored = log.retrieve("entry-10");
    expect(stored.found).toBe(true);
    if (stored.found) {
      expect(Object.isFrozen(stored.entry)).toBe(true);
      expect(() => {
        (stored.entry as unknown as { actor: string }).actor = "tampered";
      }).toThrow();
      expect(log.retrieve("entry-10")).toMatchObject({ entry: { actor: "jsmith" } });
    }
  });

  it("recording the same id with different content is a conflict, not a silent overwrite", () => {
    const log = new AuditLog();
    const original = buildDecisionAuditEntry(
      baseAction(),
      { status: "approved", decidedBy: "jsmith", decidedAt: "2026-08-18T12:00:00Z" },
      "entry-11",
      "corr-11"
    );
    const conflicting = buildDecisionAuditEntry(
      baseAction(),
      { status: "denied", decidedBy: "rjones", decidedAt: "2026-08-18T13:00:00Z" },
      "entry-11",
      "corr-11"
    );

    log.record(original);
    expect(() => log.record(conflicting)).toThrow(AuditLogConflictError);
    expect(log.retrieve("entry-11")).toMatchObject({ entry: { actor: "jsmith" } });
  });
});
