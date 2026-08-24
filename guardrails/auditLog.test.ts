import { describe, it, expect, afterEach } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuditLog,
  AuditLogConflictError,
  AuditLogValidationError,
  buildActionAuditEntry,
  buildDecisionAuditEntry,
  buildHitlAuditEntry,
  buildPolicyEvaluationAuditEntry,
  buildSystemEventAuditEntry,
} from "./auditLog.js";
import { checkRemediationGuardrail, RemediationAction } from "./remediationGuardrail.js";
import { evaluateAbacPolicy } from "./abacEvaluator.js";

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

// No platform STORY id — governance-engine extension (ABAC evaluator + HITL queue),
// reusing this same audit log rather than a second, parallel one.
describe("AuditLog — governance engine: policy_evaluation entries", () => {
  it("logs an ABAC decision with the actor and matched rule", () => {
    const log = new AuditLog();
    const request = { role: "engineer" as const, resourceType: "incident_detail" as const, action: "view" as const };
    const decision = evaluateAbacPolicy(request);
    const entry = buildPolicyEvaluationAuditEntry(request, decision, "engineer", "pe-1", "corr-pe-1", () => "2026-08-20T12:00:00Z");

    log.record(entry);

    expect(log.all()).toEqual([entry]);
    expect(entry.decision.decision).toBe("allow");
  });

  it("failure path — log entry incorrect: an entry missing a required field is rejected at write time", () => {
    const log = new AuditLog();
    const request = { role: "engineer" as const, resourceType: "incident_detail" as const, action: "view" as const };
    const decision = evaluateAbacPolicy(request);
    const entry = buildPolicyEvaluationAuditEntry(request, decision, "", "pe-2", "corr-pe-2");

    expect(() => log.record(entry)).toThrow(AuditLogValidationError);
  });
});

describe("AuditLog — governance engine: hitl_event entries", () => {
  it("logs an enqueue event and retrieves it by id", () => {
    const log = new AuditLog();
    const entry = buildHitlAuditEntry(
      "hitl_enqueued",
      "item-1",
      "pending",
      "governance_engine",
      { notified: "alex" },
      "hitl-1",
      "corr-hitl-1",
      () => "2026-08-20T12:00:00Z"
    );

    log.record(entry);

    expect(log.retrieve("hitl-1")).toEqual({ found: true, entry });
  });

  it("is idempotent: recording the identical hitl event twice does not duplicate the trail", () => {
    const log = new AuditLog();
    const entry = buildHitlAuditEntry(
      "hitl_decision",
      "item-2",
      "approved",
      "alex",
      { decision: "approve" },
      "hitl-2",
      "corr-hitl-2",
      () => "2026-08-20T12:00:00Z"
    );

    log.record(entry);
    log.record(entry);

    expect(log.all().length).toBe(1);
  });

  it("a stored hitl entry is frozen, including its nested detail object", () => {
    const log = new AuditLog();
    const entry = buildHitlAuditEntry(
      "hitl_escalated",
      "item-3",
      "escalated",
      "governance_engine",
      { escalatedTo: "jordan" },
      "hitl-3",
      "corr-hitl-3"
    );
    log.record(entry);

    const stored = log.retrieve("hitl-3");
    expect(stored.found).toBe(true);
    if (stored.found && stored.entry.entryType === "hitl_event") {
      const detail = stored.entry.detail;
      expect(Object.isFrozen(detail)).toBe(true);
      expect(() => {
        (detail as Record<string, unknown>).escalatedTo = "tampered";
      }).toThrow();
    } else {
      throw new Error("expected a found hitl_event entry");
    }
  });
});

// docs/audit-trail-design.md: mcp-server/'s operational events (recommendation,
// monitoring, escalation, notification), sharing one correlation ID with the rest of
// this audit log rather than living only in process stderr logs under a mismatched
// incidentId. No mcp-server/ wiring yet — this covers the entry type itself.
describe("AuditLog — system_event entries (docs/audit-trail-design.md)", () => {
  it("logs a successful operational event and retrieves it by id", () => {
    const log = new AuditLog();
    const entry = buildSystemEventAuditEntry(
      "escalation_triggered",
      "success",
      { incidentId: "demo-1", confidence: 20 },
      "escalationService",
      "sys-1",
      "corr-sys-1",
      () => "2026-08-20T12:00:00Z"
    );

    log.record(entry);

    expect(log.retrieve("sys-1")).toEqual({ found: true, entry });
    expect(entry.actor).toBe("escalationService");
  });

  it("logs a failed operational event distinctly from a successful one", () => {
    const entry = buildSystemEventAuditEntry(
      "operator_notification_failed",
      "failure",
      { errorClass: "UpstreamCallFailedError" },
      "notificationService",
      "sys-2",
      "corr-sys-2"
    );
    expect(entry.outcome).toBe("failure");
  });

  it("is idempotent: recording the identical system event twice does not duplicate the trail", () => {
    const log = new AuditLog();
    const entry = buildSystemEventAuditEntry(
      "monitoring_cycle",
      "success",
      { incidentDetected: false },
      "monitoringService",
      "sys-3",
      "corr-sys-3",
      () => "2026-08-20T12:00:00Z"
    );

    log.record(entry);
    log.record(entry);

    expect(log.all().length).toBe(1);
  });

  it("a stored system event is frozen, including its nested context object", () => {
    const log = new AuditLog();
    const entry = buildSystemEventAuditEntry(
      "incident_alert",
      "success",
      { sessionId: 92, blockingSessionId: 66 },
      "monitoringService",
      "sys-4",
      "corr-sys-4"
    );
    log.record(entry);

    const stored = log.retrieve("sys-4");
    expect(stored.found).toBe(true);
    if (stored.found && stored.entry.entryType === "system_event") {
      const context = stored.entry.context;
      expect(Object.isFrozen(context)).toBe(true);
      expect(() => {
        (context as Record<string, unknown>).sessionId = "tampered";
      }).toThrow();
    } else {
      throw new Error("expected a found system_event entry");
    }
  });

  it("failure path — log entry incorrect: a system event missing a required field (actor) is rejected at write time", () => {
    const log = new AuditLog();
    const entry = buildSystemEventAuditEntry(
      "monitoring_cycle",
      "success",
      {},
      "",
      "sys-5",
      "corr-sys-5"
    );

    expect(() => log.record(entry)).toThrow(AuditLogValidationError);
    expect(log.all().length).toBe(0);
  });

  it("system_event entries are retrievable alongside other entry types under the same correlation ID", () => {
    const log = new AuditLog();
    const decision = buildDecisionAuditEntry(
      { actionType: "restart_service", evidenceIds: ["evt-1"], approval: null, targetSystem: { name: "prod-app-server-03", productionWriteProtected: true } },
      { status: "approved", decidedBy: "jsmith", decidedAt: "2026-08-20T12:00:00Z" },
      "sys-6a",
      "corr-shared"
    );
    const systemEvent = buildSystemEventAuditEntry(
      "escalation_triggered",
      "success",
      { confidence: 15 },
      "escalationService",
      "sys-6b",
      "corr-shared"
    );

    log.record(decision);
    log.record(systemEvent);

    const trail = log.forCorrelationId("corr-shared");
    expect(trail).toHaveLength(2);
    expect(trail.map((e) => e.entryType).sort()).toEqual(["decision", "system_event"]);
  });
});

describe("AuditLog — persistence (ADR-005)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempLogPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "audit-log-test-"));
    tempDirs.push(dir);
    return join(dir, "audit-log.jsonl");
  }

  it("stays purely in-memory when persistTo is omitted (default, every other test in this file)", () => {
    const log = new AuditLog();
    log.record(
      buildSystemEventAuditEntry("test_event", "success", {}, "test", "sys-mem-1", "corr-mem-1")
    );
    expect(log.all()).toHaveLength(1);
  });

  it("appends a recorded entry to the persistence file as one JSON line", () => {
    const path = tempLogPath();
    const log = new AuditLog({ persistTo: path });
    const entry = buildSystemEventAuditEntry("test_event", "success", {}, "test", "sys-1", "corr-1");

    log.record(entry);

    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(entry);
  });

  it("does not append again when the same id/content is recorded twice (idempotent write)", () => {
    const path = tempLogPath();
    const log = new AuditLog({ persistTo: path });
    const entry = buildSystemEventAuditEntry("test_event", "success", {}, "test", "sys-1", "corr-1");

    log.record(entry);
    log.record(entry);

    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("rehydrates prior entries from disk when constructed with the same persistTo path", () => {
    const path = tempLogPath();
    const first = new AuditLog({ persistTo: path });
    first.record(buildSystemEventAuditEntry("test_event", "success", {}, "test", "sys-1", "corr-1"));
    first.record(buildSystemEventAuditEntry("test_event_2", "success", {}, "test", "sys-2", "corr-1"));

    const second = new AuditLog({ persistTo: path });

    expect(second.all()).toHaveLength(2);
    expect(second.retrieve("sys-1").found).toBe(true);
    expect(second.forCorrelationId("corr-1")).toHaveLength(2);
  });

  it("continues writing new entries to the same file after rehydration", () => {
    const path = tempLogPath();
    const first = new AuditLog({ persistTo: path });
    first.record(buildSystemEventAuditEntry("test_event", "success", {}, "test", "sys-1", "corr-1"));

    const second = new AuditLog({ persistTo: path });
    second.record(buildSystemEventAuditEntry("test_event_2", "success", {}, "test", "sys-2", "corr-1"));

    const lines = readFileSync(path, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(second.all()).toHaveLength(2);
  });

  it("skips an unreadable line during rehydration instead of crashing", () => {
    const path = tempLogPath();
    const first = new AuditLog({ persistTo: path });
    first.record(buildSystemEventAuditEntry("test_event", "success", {}, "test", "sys-1", "corr-1"));
    // Simulate a truncated final line from a crash mid-append.
    appendFileSync(path, '{"id":"sys-2","entryType":"system_e', "utf-8");

    const second = new AuditLog({ persistTo: path });

    expect(second.all()).toHaveLength(1);
    expect(second.retrieve("sys-1").found).toBe(true);
  });

  it("creates the parent directory if it does not exist yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-log-test-"));
    tempDirs.push(dir);
    const path = join(dir, "nested", "audit-log.jsonl");

    expect(() => new AuditLog({ persistTo: path })).not.toThrow();
  });
});
