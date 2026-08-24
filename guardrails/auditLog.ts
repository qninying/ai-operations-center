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
//
// Extended again (docs/audit-trail-design.md) to carry mcp-server/'s operational
// events — recommendation generation, monitoring cycles, escalations, notifications —
// under one shared correlation ID, closing the gap that document identifies: those
// events previously only reached process stderr via logEvent(), with no queryable,
// immutable record and no correlation ID shared with this audit log. SystemEventAuditEntry
// is deliberately a thin adapter over logEvent()'s existing {event, context} shape
// rather than a new rigid schema — unlike a decision or an ABAC check, an operational
// event's shape genuinely varies per event type, so this type doesn't pretend it's fixed.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
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

// actor for a system_event is whichever service observed/decided it (e.g.
// "recommendationService", "monitoringService") — this system is autonomous by
// design at this layer, so "actor" here means "what part of the system," the same
// way ActionAuditEntry already uses "execution-service" as an actor for a
// system-triggered action rather than requiring a human name.
export interface SystemEventAuditEntry extends AuditEntryEnvelope {
  entryType: "system_event";
  event: string;
  outcome: "success" | "failure";
  context: Record<string, unknown>;
}

export type AuditEntry =
  | DecisionAuditEntry
  | ActionAuditEntry
  | PolicyEvaluationAuditEntry
  | HitlAuditEntry
  | SystemEventAuditEntry;

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

export function buildSystemEventAuditEntry(
  event: string,
  outcome: "success" | "failure",
  context: Record<string, unknown>,
  actor: string,
  id: string,
  correlationId: string,
  now: () => string = () => new Date().toISOString()
): SystemEventAuditEntry {
  return {
    id,
    entryType: "system_event",
    correlationId,
    actor,
    event,
    outcome,
    context,
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
    case "system_event":
      Object.freeze(entry.context);
      break;
  }
  return Object.freeze(entry);
}

export interface AuditLogOptions {
  // Absolute path to an append-only JSONL file. Omitted (the default, and every
  // existing test/demo call site) means purely in-memory, exactly as before this
  // option existed — persistence is opt-in, not automatic, so unit tests stay fast
  // and never touch disk. When set, every record() call also appends one JSON line
  // here, and the constructor replays the file to rehydrate the in-memory Map, so a
  // process restart no longer loses the governance record of what was approved and
  // by whom. See ADR-005.
  persistTo?: string;
  // ADR-005 addendum: once the active persistTo file reaches this many lines, it is
  // rotated into a numbered archive segment (e.g. audit-log.1.jsonl) and a fresh
  // active file is started — bounding any single file's size without ever deleting
  // history, since this is a governance record, not a disposable debug log. Only
  // meaningful when persistTo is set. Defaults to DEFAULT_MAX_LINES_PER_SEGMENT.
  maxLinesPerSegment?: number;
}

// Chosen as a round number comfortably larger than this system's actual current
// volume (dozens of entries total across the whole project as of ADR-005) while
// still keeping each archived file small enough to open and read directly — the
// same "human-inspectable" property ADR-005 already valued in choosing JSONL over
// a database in the first place.
const DEFAULT_MAX_LINES_PER_SEGMENT = 5_000;

// Archived segments sit next to the active file, named `<base>.<n><ext>` (e.g.
// audit-log.jsonl -> audit-log.1.jsonl, audit-log.2.jsonl, ...). No separate index
// file or persisted counter is needed — the next index is always derivable by
// scanning the directory, and that scan is cheap at this system's volume.
function archiveSegmentPattern(activePath: string): RegExp {
  const ext = extname(activePath);
  const base = basename(activePath, ext);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escape(base)}\\.(\\d+)${escape(ext)}$`);
}

function scanArchivedSegments(activePath: string): Array<{ path: string; index: number }> {
  const dir = dirname(activePath);
  if (!existsSync(dir)) return [];
  const pattern = archiveSegmentPattern(activePath);
  return readdirSync(dir)
    .map((name) => {
      const match = name.match(pattern);
      return match ? { path: join(dir, name), index: Number(match[1]) } : null;
    })
    .filter((entry): entry is { path: string; index: number } => entry !== null)
    .sort((a, b) => a.index - b.index);
}

function nextArchiveSegmentPath(activePath: string): string {
  const segments = scanArchivedSegments(activePath);
  const nextIndex = segments.length > 0 ? segments[segments.length - 1].index + 1 : 1;
  const ext = extname(activePath);
  const base = basename(activePath, ext);
  return join(dirname(activePath), `${base}.${nextIndex}${ext}`);
}

// Append-only, immutable, idempotent-by-id. Per CLAUDE.md's Idempotency &
// Replayability section, `id` is the idempotency key checked before the write
// "fires": recording the same id with identical content twice (a retried write) is
// a safe no-op; the same id with *different* content is a conflict — surfaced as an
// error, not silently swallowed or silently overwritten, since entries are immutable
// by design and a mismatched id collision usually means a caller bug.
export class AuditLog {
  private entries = new Map<string, AuditEntry>();
  private readonly persistTo?: string;
  private readonly maxLinesPerSegment: number;
  private currentSegmentLines = 0;

  constructor(options: AuditLogOptions = {}) {
    this.persistTo = options.persistTo;
    this.maxLinesPerSegment = options.maxLinesPerSegment ?? DEFAULT_MAX_LINES_PER_SEGMENT;
    if (this.persistTo) {
      mkdirSync(dirname(this.persistTo), { recursive: true });
      // Oldest archived segments first, active file last — same order the entries
      // were originally written in, so this.entries (a Map) preserves chronological
      // insertion order across a restart, matching pre-rotation behavior exactly.
      for (const segment of scanArchivedSegments(this.persistTo)) {
        this.rehydrateFile(segment.path);
      }
      this.currentSegmentLines = this.rehydrateFile(this.persistTo);
    }
  }

  // A line that fails to parse or validate is skipped with a loud warning rather
  // than crashing the whole audit log — the most likely cause is a single
  // truncated final line from a crash mid-append, not a corrupted history, and a
  // governance system that refuses to start because of one bad tail line is a
  // worse failure mode than losing that one entry. See ADR-005's accepted-risk note.
  // Returns the number of non-blank raw lines in the file (whether they parsed or
  // not) — rotation counts physical lines, not valid entries, since a corrupted
  // tail line still takes up space in the file.
  private rehydrateFile(path: string): number {
    if (!existsSync(path)) return 0;
    const lines = readFileSync(path, "utf-8").split("\n").filter((line) => line.trim().length > 0);
    lines.forEach((line, index) => {
      try {
        const entry = JSON.parse(line) as AuditEntry;
        assertValid(entry);
        this.entries.set(entry.id, freezeEntry(entry));
      } catch (error) {
        console.error(
          `AuditLog: skipping unreadable line ${index + 1} in ${path} during rehydration: ` +
            (error instanceof Error ? error.message : String(error))
        );
      }
    });
    return lines.length;
  }

  // Called immediately before an append, never after — so an archived segment
  // always ends up with exactly maxLinesPerSegment lines, and the active file
  // never exceeds it. If the active file is already gone (e.g. a rotation happened
  // but the process crashed before the next append landed), there's nothing to
  // rotate; just reset the counter rather than renaming a file that doesn't exist.
  private rotateIfNeeded(): void {
    if (!this.persistTo) return;
    if (this.currentSegmentLines < this.maxLinesPerSegment) return;
    if (!existsSync(this.persistTo)) {
      this.currentSegmentLines = 0;
      return;
    }
    renameSync(this.persistTo, nextArchiveSegmentPath(this.persistTo));
    this.currentSegmentLines = 0;
  }

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
    if (this.persistTo) {
      this.rotateIfNeeded();
      appendFileSync(this.persistTo, JSON.stringify(entry) + "\n", "utf-8");
      this.currentSegmentLines += 1;
    }
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
