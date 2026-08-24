# ADR-005: Persist the Audit Trail via Append-Only JSONL File

**Status:** Implemented — built, unit-tested, and live-verified across a real server restart.
**Owner:** Quincy Nkwain Ninying
**Date:** 2026-08-24
**Component:** `guardrails/auditLog.ts`, `mcp-server/src/httpServer.ts`

---

## Context

An INPACT trust-posture assessment of CoreOps on 2026-08-24 confirmed, by reading
the code rather than assuming, that `guardrails/auditLog.ts`'s `AuditLog` class
stored every entry in a plain in-memory `Map` with no file or database backing at
all. This wasn't a theoretical gap: it was the single sharpest finding in that
assessment, because it directly undermines the system's central governance claim —
"every production change has a verifiable human approval" — a claim only as good
as the record surviving to be checked. A process restart silently erased the
entire audit history: every `hitl_enqueued`/`hitl_decision` pair, every
`decidedBy` identity (the exact fix ADR-003 made real), gone with no trace and no
error.

This ADR is the decision to close that gap.

## Decision drivers

| Driver | Source | Why it matters here |
|---|---|---|
| The record must outlive the process | The governance claim itself — "verifiable" implies "still there to verify" | An audit trail that a restart can erase isn't really an audit trail for anything that happened before the restart. |
| Zero new dependencies | This repo's own "new dependencies require a deliberate add" rule, and the fact that it currently has zero database dependencies anywhere | Whatever mechanism is chosen should not force a first-ever DB dependency onto a repo that has managed without one so far, unless the tradeoff genuinely earns it. |
| Consistency with existing conventions | `observability/logger.ts` already writes one JSON object per line as this repo's structured-logging convention | Reusing an established, already-understood format lowers the real cost of this change and avoids introducing a second, different persistence idiom. |
| Test isolation must not regress | Every existing test (`auditLog.test.ts` and ~19 other call sites across `guardrails/`, `mcp-server/`) constructs `new AuditLog()` and expects fast, disk-free, isolated behavior | Persistence must be strictly opt-in via constructor options, not the new default — otherwise every unit test in the repo starts touching disk. |
| Small, reversible step | This repo's own `CLAUDE.md`: "Small, reversible steps" | The fix should be addable without restructuring `AuditLog`'s existing API or its ~19 call sites. |

## Options considered

| | **A: Append-only JSONL file (chosen)** | **B: SQLite** | **C: Defer — document the gap, don't fix it** |
|---|---|---|---|
| New dependency | None — `node:fs` only | Yes — no SQLite/database dependency exists in this repo today | None, but fixes nothing |
| Matches existing conventions | Yes — same one-JSON-object-per-line shape `observability/logger.ts` already uses | No — a new, different persistence idiom | N/A |
| Query capability | Linear scan on rehydration into memory; runtime queries (`forCorrelationId`, `retrieve`) still served from the in-memory `Map`, unchanged and just as fast as before | Real SQL, indexes, transactional writes | N/A |
| Test isolation | Preserved — persistence is opt-in via `AuditLogOptions.persistTo`, omitted by default | Same, if built the same opt-in way | N/A |
| Residual risk | A crash exactly mid-`appendFileSync` can truncate the last line; rehydration must tolerate that | Transactional writes largely avoid this | The original gap, unchanged |
| Implementation cost | Small — one option added to an existing constructor, one append call, one rehydration loop | Larger — schema, driver, migration story for a repo that has none | None, but the scorecard's sharpest finding stays open |

Option C was rejected because the user explicitly asked for this fixed, not just
re-documented. Option B was rejected specifically on the "deliberate add" dependency
rule — SQLite is a fine choice in general, but a JSONL file gets the actual
requirement (survive a restart) with zero new moving parts, and this repo's own
structured-logging convention already established the exact file format needed.

## Decision

**`AuditLog` gains an optional `persistTo: string` constructor option.** When set:

- The constructor creates the parent directory if needed and **rehydrates** the
  in-memory `Map` by reading the file, one JSON object per line, replaying each
  through the same `assertValid`/`freezeEntry` logic `record()` already uses.
- Every `record()` call that adds a genuinely new entry (not an idempotent
  duplicate) also **appends one JSON line** to the file via `appendFileSync`,
  immediately, synchronously — audit correctness matters more than raw write
  throughput for a low-volume internal ops tool, so there is no batching or async
  write-behind to reason about.
- The idempotent-duplicate path (same `id`, same content, recorded twice) does
  **not** re-append — the file stays exactly as informative as the in-memory
  view, with no duplicate lines.
- A line that fails to parse or fails `assertValid` during rehydration is
  **skipped with a loud `console.error` warning**, not treated as a fatal
  startup error — the most likely cause is a single truncated final line from a
  crash mid-append, and a governance system refusing to start over one bad tail
  line is a worse failure mode than losing that one entry while keeping
  everything else.

`mcp-server/src/httpServer.ts`'s singleton `auditLog` instance now passes
`persistTo: join(__dirname, "..", "data", "audit-log.jsonl")`. `mcp-server/data/`
is gitignored — it's runtime-generated state, not source. Every other call site
(`~19` test files, `guardrails/demoGovernanceEngine.ts`) is **unchanged** —
`new AuditLog()` with no options continues to mean purely in-memory, exactly as
before this ADR.

## Consequences

**What this requires, already built and verified:**
- One new dependency-free option on an existing class; no change to `record()`,
  `retrieve()`, `all()`, or `forCorrelationId()`'s public signatures.
- Live-verified end to end, not just unit-tested: logged in, proposed and
  approved a real remediation (`POST /api/guardrail/propose` →
  `POST /api/guardrail/decide`), confirmed both the `hitl_enqueued` and
  `hitl_decision` entries landed in `mcp-server/data/audit-log.jsonl` with the
  real approver identity, killed the server process outright, restarted it, and
  confirmed `GET /api/audit?correlationId=` still returned both entries —
  proving the fix, not just the wiring.
- 7 new unit tests in `auditLog.test.ts`: default in-memory behavior unchanged,
  append-on-record, no-append-on-idempotent-duplicate, rehydration from a fresh
  instance, continued appending after rehydration, skip-corrupted-line, and
  parent-directory creation.

**What this explicitly does not cover (flagged, not silently skipped):**
- **No corruption recovery beyond skip-and-warn.** A crash mid-write can lose at
  most the one entry that was mid-write, never any entry before it — the file is
  append-only and prior lines are untouched — but there's no checksum or repair
  tool if the file is corrupted by some other means.
- **Still single-process, single-file.** If `mcp-server` is ever horizontally
  scaled, this file-per-process approach breaks the same way the in-memory
  `SessionStore` would (see ADR-003's own "what would change this decision") —
  a shared store becomes necessary at that point, not before.

## Implementation addendum (2026-08-24): log rotation

The "no log rotation" gap above was closed the same day it was flagged, as part of
an INPACT trust-posture audit that named it as Non-repudiation's one remaining
named gap (Band 3, not yet Hardened).

**Decision:** size-based rotation into numbered archive segments, never deletion.
This is a governance record, not a disposable debug log — every entry ever
recorded must remain queryable indefinitely, so "rotation" here means bounding any
*single* file's size, not expiring old data. `AuditLog` gained an optional
`maxLinesPerSegment` constructor option (default 5,000 — comfortably above this
system's actual volume, small enough that any one archived file stays easy to
open and read directly, matching JSONL's original "human-inspectable" rationale
from the Decision section above). Once the active `persistTo` file reaches that
line count, the next `record()` call renames it to `<base>.<n>.jsonl` (e.g.
`audit-log.1.jsonl`, `audit-log.2.jsonl`, ...) before appending — no separate
index file or persisted counter; the next `n` is always derived by scanning the
directory for existing `<base>.<n>.jsonl` files, cheap at this volume.

**Rehydration** now reads every archived segment (oldest first, by `n`) and then
the active file, replaying all of them into the same in-memory `Map` exactly as
before — `retrieve()`, `all()`, and `forCorrelationId()` are completely unchanged
and don't know or care how many files the history is split across. Chronological
insertion order is preserved across a restart, matching pre-rotation behavior.

**Options considered:** time-based rotation (daily/monthly files) was rejected —
size-based directly bounds what actually matters (file size, rehydration cost),
where time-based would let a burst of activity produce one huge daily file just
the same. Deleting old segments after N days was rejected outright — this is the
audit trail the whole system's governance claim rests on; silently expiring old
entries would quietly break "every production change has a verifiable human
approval" for anything old enough to be dropped, the same category of regression
ADR-005 itself was written to close.

**Verification:** 7 new unit tests (rotation at threshold, no premature rotation,
rehydration across archived + active segments, multiple sequential rotations,
in-memory continuity across a rotation within one running instance, idempotent
duplicates near a rotation boundary don't rotate twice, default threshold high
enough that ordinary use never rotates). Live-verified against a copy of the
real, running system's actual `audit-log.jsonl` (48 real entries at the time) —
not synthetic data: rehydrated all 48 real entries through the new code, recorded
one more with a deliberately small threshold to force an immediate rotation,
confirmed the archived segment held all 48 original lines byte-for-byte, the new
entry landed in a fresh active file, and a second rehydration correctly saw all
49. The real, live `mcp-server/data/audit-log.jsonl` itself was never touched by
this test (48 lines, well under the real 5,000-line default) — only a scratch
copy was.

## What would change this decision

- **Sustained high write volume or a real need for indexed/SQL queries over the
  audit history** (not just "retrieve by id" or "retrieve by correlation ID,"
  both already served fine from memory) would be a real reason to move to
  SQLite or an external database — at that point Option B's tradeoffs finally
  earn their cost.
- **Horizontal scaling of `mcp-server`** would require this to become a shared
  store rather than a local file, for the same reason ADR-003 already flags for
  `SessionStore`.
- **Compliance requirements for tamper-evidence** (cryptographic chaining,
  write-once storage) would be a reason to revisit the append-only-file
  approach entirely, not just its location.
