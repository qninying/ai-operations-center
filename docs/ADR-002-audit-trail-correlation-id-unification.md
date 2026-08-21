# ADR-002: Unify Correlation IDs Between `mcp-server/` and `guardrails/auditLog.ts`

**Status:** Proposed — step 1 (the audit log entry type) is implemented; steps 2-4
below are not yet built.
**Owner:** Quincy Nkwain Ninying
**Date:** 2026-08-20
**Component:** `guardrails/auditLog.ts`, `mcp-server/src/`

---

## Context

`docs/audit-trail-design.md` lays out the general principles a correlation-ID-based
audit trail needs. This ADR is the specific, CoreOps-scoped decision that follows from
it: two mechanisms already exist in this repo, built for different purposes, and they
don't currently share an identifier scheme.

### 1. `guardrails/auditLog.ts` — already does this correctly

Built for STORY-001/002 (REQ-001, REQ-005) and extended (no platform story) to also
cover ABAC policy evaluation and the human-in-the-loop approval queue
(`abacEvaluator.ts`, `hitlQueue.ts`):

- Every `AuditEntry` carries a mandatory `correlationId`, enforced at write time
  (`guardrails/auditLog.ts`'s `AuditEntryEnvelope`, `assertValid()`).
- `AuditLog.record()` is immutable and idempotent by `id` — the same entry recorded
  twice is a safe no-op; the same `id` with different content is a hard
  `AuditLogConflictError`.
- `AuditLog.forCorrelationId(id)` is the reconstruction query — pull every entry that
  shares one ID and get the ordered story back.
- `guardrails/demoGovernanceEngine.ts` demonstrates this working end to end: a policy
  evaluation, a HITL enqueue, an approval decision, and a post-approval re-check, all
  sharing one `correlationId`, all retrievable together.

### 2. `mcp-server/src/`'s structured logging — real, but not an audit trail

`recommendationService.ts`, `cloudRecommendationService.ts`, `monitoringService.ts`,
`escalationService.ts`, and `notificationService.ts` all log through
`observability/logger.ts`'s `logEvent()` — real, well-tested, every failure path
covered — but:

- No first-class correlation field. Each call site stuffs an `incidentId` into a
  free-form `context` object, an ad hoc convention `logEvent()` doesn't enforce.
- **The IDs don't actually match across the chain.** `httpServer.ts` generates a fresh
  `incidentId` (`crypto.randomUUID()`) per HTTP request for `/api/recommendation` and
  `/api/cloud-recommendation`. `monitoringService.ts`'s autonomous cycles build a
  *different-shaped* identifier from DMV data
  (`sql:sys.dm_exec_requests:${session_id}`), generated independently, with no link
  back to whatever ID a later `/api/recommendation` call about the same real incident
  would carry.
- It isn't queryable, immutable, or retained — stderr JSON lines are good for `tail`-ing
  a live process, not for answering "what happened to incident X" after the fact.

The root `CLAUDE.md`'s Observability Framework already specifies the target contract
this should converge on: a correlation ID generated at the entry point of any request
or job, propagated through every log line, downstream call, and database write. That
target isn't implemented in `mcp-server/` yet.

## Decision drivers

| Driver | Why it matters here |
|---|---|
| Don't build a second audit system | `guardrails/auditLog.ts` already implements the target correctly — immutable, idempotent, queryable by correlation ID. The gap is that nothing outside `guardrails/` writes to it, not that the mechanism itself needs replacing. |
| Preserve existing consumers | `hitlQueue.ts` and `demoGovernanceEngine.ts` depend on today's `AuditEntry` union and its four variants. Any change here must be additive. |
| Match this codebase's existing DI pattern | Every `mcp-server/` service already takes injectable functions (`queryFn`, `analyzeFn`, `notifyFn`) for testability. Wiring in an `AuditLog` instance should follow the same shape, not invent a new one. |
| A real, demoable "why did this happen" answer | The whole point of closing this gap is `forCorrelationId()` actually returning something for a real CoreOps incident — an operator's actual question, not just a design principle. |

## Decision

Extend `guardrails/auditLog.ts` with one new entry type covering `mcp-server/`'s
operational events, then wire each service to write through it, unifying on one
correlation ID per real-world incident.

### Step 1 — `SystemEventAuditEntry` (implemented)

A thin adapter over `logEvent()`'s existing `{event, context}` shape —
`{ entryType: "system_event", event: string, outcome: "success" | "failure", context:
Record<string, unknown> }` — rather than a rigid schema like the governance-specific
entry types have. Unlike a decision or an ABAC check, an operational event's shape
genuinely varies per event type, so this type doesn't pretend it's fixed. `actor` for a
system event is whichever service observed it (`"recommendationService"`,
`"monitoringService"`, etc.) — this system is autonomous at this layer, so "actor" means
"what part of the system," the same way `ActionAuditEntry` already uses
`"execution-service"` as an actor for a system-triggered action.

Added: the `SystemEventAuditEntry` type, `buildSystemEventAuditEntry()`, a
`freezeEntry()` case (freezing `context`), and 6 new tests — a valid entry records and
freezes correctly, a failure outcome is distinguishable from success, idempotency by
id, the existing `assertValid()` rejection applies to it too, and — the point of this
whole ADR — a `system_event` entry is retrievable via `forCorrelationId()` alongside a
`decision` entry sharing the same ID. 50/50 `guardrails` tests passing (up from 44),
`tsc --noEmit` clean.

### Step 2 — one correlation ID per incident, generated once, at the true entry point
(not yet built)

- HTTP-triggered incidents: `httpServer.ts` already generates one ID at the right
  place (`crypto.randomUUID()` if the caller didn't supply one) — rename/treat it as
  `correlationId` explicitly rather than keeping it as a separately-named `incidentId`
  that happens to serve the same purpose.
- Monitoring-detected incidents (no inbound request): generate the correlation ID in
  `monitoringService.ts`'s `runMonitoringCycle()` the moment `hasIncident()` returns a
  row — once, there — and thread that same value through the `incident_alert` log and
  the `notifyOperators()` call, rather than each step minting its own identifier.
- Never generate a new ID partway through a chain — the same discipline
  `notifyOperators()` already applies to `incidentId` today, extended to cover the
  whole chain, not one hop of it.

### Step 3 — write into `AuditLog`, not just stderr (not yet built)

Each `mcp-server/` service takes an injectable `AuditLog` instance, the same DI pattern
as `queryFn`/`analyzeFn`/`notifyFn`, and records a `SystemEventAuditEntry` alongside
(not instead of) its existing `logEvent()` call — `logEvent()` stays the live
operational view; `AuditLog` becomes the durable, queryable one.

### Step 4 — never drop the correlation ID on a failure path (not yet built)

Every failure branch already logs an outcome — the correlation ID needs to be present
on every one of those audit writes too, not just the happy path, matching what's
already true of every `logEvent()` failure call today.

## Consequences

**What this requires, if the remaining steps are approved:**
- `httpServer.ts` and `monitoringService.ts` become the two places a correlation ID is
  ever minted; every other function receives it as a parameter.
- Each `mcp-server/` service's function signature grows one more optional injectable
  (`auditLog?: AuditLog`), same shape as existing injectables.
- A new `GET /api/audit/:correlationId`-style route (or equivalent) to actually
  demonstrate `forCorrelationId()` reconstruction live — otherwise the audit log's
  core value (queryability) has no way to be shown, only asserted in a test.

**What this does not require:**
- No change to `DecisionAuditEntry`/`ActionAuditEntry`/`PolicyEvaluationAuditEntry`/
  `HitlAuditEntry` or their consumers (`hitlQueue.ts`, `demoGovernanceEngine.ts`) —
  step 1 is additive only.
- No new external dependency — `crypto.randomUUID()` (already used in `hitlQueue.ts`
  and `httpServer.ts`) and the existing `AuditLog` class are sufficient.
- No cross-process propagation (`X-Correlation-ID` headers) yet — everything in
  `mcp-server/` today is one process. Worth keeping the ID a plain UUID-shaped string
  now so adopting the header later, if CoreOps becomes genuinely multi-process, is a
  non-event.

## What would change this decision

- If the target Telemetry Store (TimescaleDB, per `architecture.md`) is stood up
  before steps 2-4 are built, step 3 should write there instead of (or in addition to)
  the in-memory `AuditLog`, since `AuditLog` has no persistence across a process
  restart today.
- If CoreOps moves to genuinely multiple processes/services before this is finished,
  cross-process propagation stops being deferred work and becomes part of step 2.
