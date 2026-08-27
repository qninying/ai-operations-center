import { describe, it, expect } from "vitest";
import { AuditLog } from "./auditLog.js";
import { HitlQueue, UnauthorizedDeciderError, MfaRequiredError, AlreadyDecidedError } from "./hitlQueue.js";

function makeClock(startAt = 0) {
  let time = startAt;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

function makeIdSequence(prefix: string) {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

describe("HitlQueue", () => {
  it("enqueues a pending item and logs the enqueue event (happy path)", () => {
    const auditLog = new AuditLog();
    const queue = new HitlQueue(auditLog, { generateId: makeIdSequence("item") });

    const item = queue.enqueue({
      request: { incident: "INC-4471" },
      correlationId: "corr-1",
      contextPackage: "Root cause: deadlock. Confidence: 91%.",
      primaryApprover: "alex",
      backupApprover: "jordan",
    });

    expect(item.status).toBe("pending");
    expect(item.activeApprover).toBe("alex");
    const enqueueEntries = auditLog.forCorrelationId("corr-1").filter(
      (e) => e.entryType === "hitl_event" && e.hitlEventType === "hitl_enqueued"
    );
    expect(enqueueEntries.length).toBe(1);
  });

  it("approves when the assigned approver decides with MFA", () => {
    const auditLog = new AuditLog();
    const queue = new HitlQueue(auditLog, { generateId: makeIdSequence("item") });
    const item = queue.enqueue({
      request: {},
      correlationId: "corr-2",
      contextPackage: "",
      primaryApprover: "alex",
      backupApprover: "jordan",
    });

    const decided = queue.decide(item.itemId, "approve", "alex", true);

    expect(decided.status).toBe("approved");
    expect(decided.decidedBy).toBe("alex");
  });

  it("failure path — decision rejected: a decider who is not the assigned approver cannot decide", () => {
    const auditLog = new AuditLog();
    const queue = new HitlQueue(auditLog, { generateId: makeIdSequence("item") });
    const item = queue.enqueue({
      request: {},
      correlationId: "corr-3",
      contextPackage: "",
      primaryApprover: "alex",
      backupApprover: "jordan",
    });

    expect(() => queue.decide(item.itemId, "approve", "someone_else", true)).toThrow(UnauthorizedDeciderError);
    expect(queue.checkForTimeout(item.itemId).status).toBe("pending"); // unaffected by the rejected attempt
  });

  it("failure path — decision rejected: the assigned approver cannot decide without MFA on the session", () => {
    const auditLog = new AuditLog();
    const queue = new HitlQueue(auditLog, { generateId: makeIdSequence("item") });
    const item = queue.enqueue({
      request: {},
      correlationId: "corr-4",
      contextPackage: "",
      primaryApprover: "alex",
      backupApprover: "jordan",
    });

    expect(() => queue.decide(item.itemId, "approve", "alex", false)).toThrow(MfaRequiredError);
  });

  it("auto-escalates to the backup approver once the decision window elapses with no decision", () => {
    const clock = makeClock();
    const auditLog = new AuditLog();
    const queue = new HitlQueue(auditLog, {
      decisionWindowMs: 600_000,
      now: clock.now,
      generateId: makeIdSequence("item"),
    });
    const item = queue.enqueue({
      request: {},
      correlationId: "corr-5",
      contextPackage: "",
      primaryApprover: "alex",
      backupApprover: "jordan",
    });

    clock.advance(600_000); // exactly at the boundary
    const escalated = queue.checkForTimeout(item.itemId);

    expect(escalated.status).toBe("escalated");
    expect(escalated.activeApprover).toBe("jordan");
  });

  it("boundary — does not escalate one millisecond before the window elapses", () => {
    const clock = makeClock();
    const auditLog = new AuditLog();
    const queue = new HitlQueue(auditLog, {
      decisionWindowMs: 600_000,
      now: clock.now,
      generateId: makeIdSequence("item"),
    });
    const item = queue.enqueue({
      request: {},
      correlationId: "corr-6",
      contextPackage: "",
      primaryApprover: "alex",
      backupApprover: "jordan",
    });

    clock.advance(599_999);
    expect(queue.checkForTimeout(item.itemId).status).toBe("pending");
  });

  it("rejects the original approver's late decision after escalation, and accepts the backup approver's instead", () => {
    const clock = makeClock();
    const auditLog = new AuditLog();
    const queue = new HitlQueue(auditLog, {
      decisionWindowMs: 600_000,
      now: clock.now,
      generateId: makeIdSequence("item"),
    });
    const item = queue.enqueue({
      request: {},
      correlationId: "corr-7",
      contextPackage: "",
      primaryApprover: "alex",
      backupApprover: "jordan",
    });

    clock.advance(600_000);
    queue.checkForTimeout(item.itemId);

    expect(() => queue.decide(item.itemId, "approve", "alex", true)).toThrow(UnauthorizedDeciderError);

    const decided = queue.decide(item.itemId, "approve", "jordan", true);
    expect(decided.status).toBe("approved");
    expect(decided.decidedBy).toBe("jordan");
  });

  it("is idempotent-safe against re-checking timeout on an already-decided item — a decided item never re-escalates", () => {
    const clock = makeClock();
    const auditLog = new AuditLog();
    const queue = new HitlQueue(auditLog, {
      decisionWindowMs: 600_000,
      now: clock.now,
      generateId: makeIdSequence("item"),
    });
    const item = queue.enqueue({
      request: {},
      correlationId: "corr-8",
      contextPackage: "",
      primaryApprover: "alex",
      backupApprover: "jordan",
    });

    queue.decide(item.itemId, "approve", "alex", true);
    clock.advance(10_000_000); // long past the window

    expect(queue.checkForTimeout(item.itemId).status).toBe("approved");
  });

  it("idempotency: a repeated decide() call on an already-approved item is rejected, not silently re-run — a network retry or double-click must not re-trigger execution", () => {
    const auditLog = new AuditLog();
    const queue = new HitlQueue(auditLog, { generateId: makeIdSequence("item") });
    const item = queue.enqueue({
      request: {},
      correlationId: "corr-9",
      contextPackage: "",
      primaryApprover: "alex",
      backupApprover: "jordan",
    });

    const first = queue.decide(item.itemId, "approve", "alex", true);
    expect(first.status).toBe("approved");

    expect(() => queue.decide(item.itemId, "approve", "alex", true)).toThrow(AlreadyDecidedError);

    // The item's real state is untouched by the rejected repeat attempt.
    const stillApproved = queue.checkForTimeout(item.itemId);
    expect(stillApproved.status).toBe("approved");
    expect(stillApproved.decidedBy).toBe("alex");
  });

  it("idempotency: applies to reject and needs_info too, not just approve", () => {
    const auditLog = new AuditLog();
    const queue = new HitlQueue(auditLog, { generateId: makeIdSequence("item") });
    const item = queue.enqueue({
      request: {},
      correlationId: "corr-10",
      contextPackage: "",
      primaryApprover: "alex",
      backupApprover: "jordan",
    });

    queue.decide(item.itemId, "reject", "alex", true);

    expect(() => queue.decide(item.itemId, "approve", "alex", true)).toThrow(AlreadyDecidedError);
  });

  it("a repeated decide() attempt is itself audited, and does not produce a duplicate hitl_decision entry", () => {
    const auditLog = new AuditLog();
    const queue = new HitlQueue(auditLog, { generateId: makeIdSequence("item") });
    const item = queue.enqueue({
      request: {},
      correlationId: "corr-11",
      contextPackage: "",
      primaryApprover: "alex",
      backupApprover: "jordan",
    });

    queue.decide(item.itemId, "approve", "alex", true);
    expect(() => queue.decide(item.itemId, "approve", "alex", true)).toThrow(AlreadyDecidedError);

    const entries = auditLog.forCorrelationId("corr-11");
    const decisions = entries.filter((e) => e.entryType === "hitl_event" && e.hitlEventType === "hitl_decision");
    const rejections = entries.filter(
      (e) => e.entryType === "hitl_event" && e.hitlEventType === "hitl_decision_rejected" && e.outcome === "rejected_already_decided"
    );
    expect(decisions.length).toBe(1); // the real approval, exactly once
    expect(rejections.length).toBe(1); // the repeat attempt, logged as rejected, not silently dropped
  });
});
