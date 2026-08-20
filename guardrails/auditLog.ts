// STORY-001 (REQ-001) needed "every approval decision is logged for audit."
// STORY-002 (REQ-005) generalizes that into "every decision AND action is logged for
// audit, retrievable by ID, timestamped, immutable" — this module reuses and extends
// the STORY-001 log rather than adding a second, parallel one, per that story's own
// "already specified before this one — reuse it, do not rebuild it" instruction.
//
// This still does not implement the full detection -> recommendation -> approval ->
// execution-outcome trail from R4's property 4 in requirements.md: there is no
// detection/recommendation subsystem yet (R1 is UNMAPPED), so there is nothing further
// upstream to log yet. This closes the decision+action half of that trail, not all of it.
//
// Extended (no platform STORY id) to also carry ABAC policy-evaluation and HITL-queue
// events — abacEvaluator.ts and hitlQueue.ts write here rather than standing up a
// second, parallel audit trail. Existing DecisionAuditEntry/ActionAuditEntry consumers
// are unaffected: this only widens the AuditEntry union and adds two new builders.

import { ApprovalDecision, GuardrailResult, RemediationAction } from "./remediationGuardrail.js";
import { AbacDecision } from "./abacEvaluator.js";
import { AbacRequest } from "./abacPolicy.js";

interface AuditEntryEnvelope {
  id: string;
  correlationId: string;
  actor: string;
  loggedAt: string;
}

export interface DecisionAuditEntry extends AuditEntryEnvelope {
  entryType: "decision";
  actionType: string;
  targetSystem: string;
  decision: ApprovalDecision;
}

export interface ActionAuditEntry extends AuditEntryEnvelope {
  entryType: "action";
  actionType: string;
  targetSystem: string;
  outcome: "executed" | "blocked";
  violations: GuardrailResult["violations"];
}

export interface PolicyEvaluationAuditEntry extends AuditEntryEnvelope {
  entryType: "policy_evaluation";
  request: AbacRequest;
  decision: AbacDecision;
}

export type HitlEventType = "hitl_enqueued" | "hitl_decision" | "hitl_escalated" | "hitl_decision_rejected";

export interface HitlAuditEntry extends AuditEntryEnvelope {
  entryType: "hitl_event";
  hitlEventType: HitlEventType;
  itemId: string;
  outcome: string;
  detail: Record<string, unknown>;
}

export type AuditEntry = DecisionAuditEntry | ActionAuditEntry | PolicyEvaluationAuditEntry | HitlAuditEntry;

export function buildDecisionAuditEntry(
  action: RemediationAction,
  decision: ApprovalDecision,
  id: string,
  correlationId: string,
  now: () => string = () => new Date().toISOString()
): DecisionAuditEntry {
  return {
    id,
    entryType: "decision",
    correlationId,
    actor: decision.decidedBy,
    actionType: action.actionType,
    targetSystem: action.targetSystem.name,
    decision,
    loggedAt: now(),
  };
}

export function buildActionAuditEntry(
  action: RemediationAction,
  result: GuardrailResult,
  actor: string,
  id: string,
  correlationId: string,
  now: () => string = () => new Date().toISOString()
): ActionAuditEntry {
  return {
    id,
    entryType: "action",
    correlationId,
    actor,
    actionType: action.actionType,
    targetSystem: action.targetSystem.name,
    outcome: result.allowed ? "executed" : "blocked",
    violations: result.violations,
    loggedAt: now(),
  };
}

export function buildPolicyEvaluationAuditEntry(
  request: AbacRequest,
  decision: AbacDecision,
  actor: string,
  id: string,
  correlationId: string,
  now: () => string = () => new Date().toISOString()
): PolicyEvaluationAuditEntry {
  return {
    id,
    entryType: "policy_evaluation",
    correlationId,
    actor,
    request,
    decision,
    loggedAt: now(),
  };
}

export function buildHitlAuditEntry(
  hitlEventType: HitlEventType,
  itemId: string,
  outcome: string,
  actor: string,
  detail: Record<string, unknown>,
  id: string,
  correlationId: string,
  now: () => string = () => new Date().toISOString()
): HitlAuditEntry {
  return {
    id,
    entryType: "hitl_event",
    correlationId,
    actor,
    hitlEventType,
    itemId,
    outcome,
    detail,
    loggedAt: now(),
  };
}

export class AuditLogValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditLogValidationError";
  }
}

export class AuditLogConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditLogConflictError";
  }
}

function assertValid(entry: AuditEntry): void {
  if (!entry.id || !entry.correlationId || !entry.actor || !entry.loggedAt) {
    throw new AuditLogValidationError(
      `Audit log entry is missing a required field (id/correlationId/actor/loggedAt): ${JSON.stringify(entry)}`
    );
  }
}

function sameContent(a: AuditEntry, b: AuditEntry): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Explicit per-type branches, not an if/else -- adding a fifth AuditEntry variant
// with a nested mutable field later should force a compile error here (an
// unhandled `entryType` falls through with nothing frozen) rather than silently
// shipping a new entry type whose nested object stays mutable.
function freezeEntry(entry: AuditEntry): AuditEntry {
  switch (entry.entryType) {
    case "decision":
      Object.freeze(entry.decision);
      break;
    case "action":
      Object.freeze(entry.violations);
      break;
    case "policy_evaluation":
      Object.freeze(entry.decision);
      Object.freeze(entry.request);
      break;
    case "hitl_event":
      Object.freeze(entry.detail);
      break;
  }
  return Object.freeze(entry);
}

// Append-only, immutable, idempotent-by-id. Per CLAUDE.md's Idempotency &
// Replayability section, `id` is the idempotency key checked before the write
// "fires": recording the same id with identical content twice (a retried write) is
// a safe no-op; the same id with *different* content is a conflict — surfaced as an
// error, not silently swallowed or silently overwritten, since entries are immutable
// by design and a mismatched id collision usually means a caller bug.
export class AuditLog {
  private entries = new Map<string, AuditEntry>();

  record(entry: AuditEntry): void {
    assertValid(entry);
    const existing = this.entries.get(entry.id);
    if (existing) {
      if (sameContent(existing, entry)) {
        return;
      }
      throw new AuditLogConflictError(
        `Audit log entry id "${entry.id}" already exists with different content — entries are immutable and cannot be overwritten.`
      );
    }
    this.entries.set(entry.id, freezeEntry(entry));
  }

  retrieve(id: string): { found: true; entry: AuditEntry } | { found: false } {
    const entry = this.entries.get(id);
    return entry ? { found: true, entry } : { found: false };
  }

  all(): ReadonlyArray<AuditEntry> {
    return Array.from(this.entries.values());
  }

  forCorrelationId(correlationId: string): ReadonlyArray<AuditEntry> {
    return this.all().filter((entry) => entry.correlationId === correlationId);
  }
}
