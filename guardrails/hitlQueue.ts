// Human-in-the-loop queue for actions the ABAC policy marked "require_approval"
// (see abacPolicy.ts's orchestrator-request-execution-requires-approval rule).
// Deterministic via an injectable clock, same pattern as CircuitBreaker in the
// mcp-server reliability module: enqueue -> notify the on-call approver -> a bounded
// decision window -> decide, or auto-escalate to a backup approver on timeout.
//
// Notification here is data only (who was notified, recorded to the audit log), not a
// real dispatch call -- this package is deliberately dependency-free (see
// remediationGuardrail.ts's header note on why), so wiring an actual notification
// (mcp-server/src/notificationService.ts's notifyOperators(), already built for
// STORY-010) is the caller's job, not this module's, the same "caller writes the
// trail" split remediationGuardrail.ts already draws for audit-completeness.

import { AuditLog, buildHitlAuditEntry } from "./auditLog.js";

export type HitlItemStatus = "pending" | "approved" | "rejected" | "needs_info" | "escalated";
export type HitlDecision = "approve" | "reject" | "needs_info";

export interface QueueItem {
  itemId: string;
  correlationId: string;
  request: Record<string, unknown>;
  contextPackage: string;
  primaryApprover: string;
  backupApprover: string;
  enqueuedAt: number;
  status: HitlItemStatus;
  activeApprover: string;
  decision: HitlDecision | null;
  decidedBy: string | null;
}

export class HitlItemNotFoundError extends Error {
  readonly errorClass = "HitlItemNotFoundError" as const;
  constructor(readonly itemId: string) {
    super(`No HITL queue item with id "${itemId}".`);
    this.name = "HitlItemNotFoundError";
  }
}

export class UnauthorizedDeciderError extends Error {
  readonly errorClass = "UnauthorizedDeciderError" as const;
  constructor(readonly attemptedBy: string, readonly assignedTo: string) {
    super(`"${attemptedBy}" is not the assigned approver for this item ("${assignedTo}" is).`);
    this.name = "UnauthorizedDeciderError";
  }
}

export class MfaRequiredError extends Error {
  readonly errorClass = "MfaRequiredError" as const;
  constructor(readonly decidedBy: string) {
    super(`"${decidedBy}" must have MFA on this session to decide a high-risk item.`);
    this.name = "MfaRequiredError";
  }
}

// Idempotency guard: a repeated decide() call on an already-decided item (a
// network retry, a double-click, a resubmitted request) must not re-run
// approval logic or let a caller re-trigger execution — see the root
// CLAUDE.md's non-negotiable "every side effect is idempotent" rule, and
// httpServer.ts's POST /api/guardrail/decide, the only path that actually
// executes a remediation.
export class AlreadyDecidedError extends Error {
  readonly errorClass = "AlreadyDecidedError" as const;
  constructor(readonly itemId: string, readonly existingStatus: HitlItemStatus) {
    super(`Item "${itemId}" was already decided (status: "${existingStatus}") and cannot be decided again.`);
    this.name = "AlreadyDecidedError";
  }
}

const DECIDED_STATUSES: readonly HitlItemStatus[] = ["approved", "rejected", "needs_info"];

export interface HitlQueueOptions {
  decisionWindowMs?: number;
  now?: () => number;
  generateId?: () => string;
}

const DEFAULT_DECISION_WINDOW_MS = 15 * 60_000;

export class HitlQueue {
  private items = new Map<string, QueueItem>();
  private readonly decisionWindowMs: number;
  private readonly now: () => number;
  private readonly generateId: () => string;

  constructor(private readonly auditLog: AuditLog, options: HitlQueueOptions = {}) {
    this.decisionWindowMs = options.decisionWindowMs ?? DEFAULT_DECISION_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    this.generateId = options.generateId ?? (() => crypto.randomUUID());
  }

  enqueue(params: {
    request: Record<string, unknown>;
    correlationId: string;
    contextPackage: string;
    primaryApprover: string;
    backupApprover: string;
  }): QueueItem {
    const item: QueueItem = {
      itemId: this.generateId(),
      correlationId: params.correlationId,
      request: params.request,
      contextPackage: params.contextPackage,
      primaryApprover: params.primaryApprover,
      backupApprover: params.backupApprover,
      enqueuedAt: this.now(),
      status: "pending",
      activeApprover: params.primaryApprover,
      decision: null,
      decidedBy: null,
    };
    this.items.set(item.itemId, item);

    this.auditLog.record(
      buildHitlAuditEntry(
        "hitl_enqueued",
        item.itemId,
        "pending",
        "governance_engine",
        { notified: item.primaryApprover, contextPackage: item.contextPackage },
        this.generateId(),
        item.correlationId
      )
    );

    return item;
  }

  private get(itemId: string): QueueItem {
    const item = this.items.get(itemId);
    if (!item) throw new HitlItemNotFoundError(itemId);
    return item;
  }

  // Escalates to the backup approver if the decision window has elapsed with no
  // decision. Call before reading/deciding an item -- a real deployment would run
  // this on a scheduler; tests call it explicitly so the timeout stays deterministic
  // rather than depending on wall-clock sleeps.
  checkForTimeout(itemId: string): QueueItem {
    const item = this.get(itemId);
    if (item.status === "pending" && this.now() - item.enqueuedAt >= this.decisionWindowMs) {
      item.status = "escalated";
      item.activeApprover = item.backupApprover;
      item.enqueuedAt = this.now();

      this.auditLog.record(
        buildHitlAuditEntry(
          "hitl_escalated",
          item.itemId,
          "escalated",
          "governance_engine",
          {
            reason: `No decision from ${item.primaryApprover} within ${this.decisionWindowMs}ms`,
            escalatedTo: item.backupApprover,
          },
          this.generateId(),
          item.correlationId
        )
      );
    }
    return item;
  }

  // Only the currently-assigned approver may decide, and only with MFA on the
  // session -- both are properties of who's allowed to act on *this specific
  // pending item*, not a general resource-access rule, so they're enforced here
  // rather than in abacEvaluator.ts.
  decide(itemId: string, decision: HitlDecision, decidedBy: string, mfa: boolean): QueueItem {
    const item = this.get(itemId);

    if (DECIDED_STATUSES.includes(item.status)) {
      this.auditLog.record(
        buildHitlAuditEntry(
          "hitl_decision_rejected",
          item.itemId,
          "rejected_already_decided",
          decidedBy,
          { attemptedDecision: decision, existingStatus: item.status, existingDecidedBy: item.decidedBy },
          this.generateId(),
          item.correlationId
        )
      );
      throw new AlreadyDecidedError(item.itemId, item.status);
    }

    if (decidedBy !== item.activeApprover) {
      this.auditLog.record(
        buildHitlAuditEntry(
          "hitl_decision_rejected",
          item.itemId,
          "rejected_not_assigned_approver",
          decidedBy,
          { attemptedBy: decidedBy, assignedTo: item.activeApprover },
          this.generateId(),
          item.correlationId
        )
      );
      throw new UnauthorizedDeciderError(decidedBy, item.activeApprover);
    }

    if (!mfa) {
      this.auditLog.record(
        buildHitlAuditEntry(
          "hitl_decision_rejected",
          item.itemId,
          "rejected_no_mfa",
          decidedBy,
          {},
          this.generateId(),
          item.correlationId
        )
      );
      throw new MfaRequiredError(decidedBy);
    }

    const statusByDecision: Record<HitlDecision, HitlItemStatus> = {
      approve: "approved",
      reject: "rejected",
      needs_info: "needs_info",
    };
    item.status = statusByDecision[decision];
    item.decision = decision;
    item.decidedBy = decidedBy;

    this.auditLog.record(
      buildHitlAuditEntry(
        "hitl_decision",
        item.itemId,
        item.status,
        decidedBy,
        { decision },
        this.generateId(),
        item.correlationId
      )
    );

    return item;
  }
}
