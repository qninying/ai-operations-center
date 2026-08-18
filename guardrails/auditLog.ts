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

import { ApprovalDecision, GuardrailResult, RemediationAction } from "./remediationGuardrail.js";

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

export type AuditEntry = DecisionAuditEntry | ActionAuditEntry;

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

function freezeEntry(entry: AuditEntry): AuditEntry {
  if (entry.entryType === "decision") {
    Object.freeze(entry.decision);
  } else {
    Object.freeze(entry.violations);
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
