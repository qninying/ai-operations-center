# ADR-010: Source-Aware Remediation, Real SQL DBA Judgment, Honest Execution Labeling

**Status:** Implemented — built, unit-tested, and live-verified against the real running server, including a real bug found and fixed during that verification.
**Owner:** Quincy Nkwain Ninying
**Date:** 2026-08-27
**Component:** `mcp-server/src/sqlRemediationSafety.ts`, `mcp-server/src/dmvFixtures.ts`, `guardrails/remediationGuardrail.ts`, `mcp-server/src/httpServer.ts`, `mcp-server/src/dashboard.html`

---

## Context

Every incident, regardless of source, proposed the exact same hardcoded
demo action — `restart_service` on `monitoring-collector`.
`POST /api/guardrail/propose` took no incident context at all. Asked
directly in review what the highest-leverage next move was — closing this
gap, not adding a fifth data source, since integration breadth doesn't
demonstrate architecture skill the way source-aware remediation does.

**Two real forks resolved directly with the user, not assumed:**

1. SQL blocking-chain incidents don't fit any of the 4 existing allowed
   action types (`restart_service`, `clear_queue`, `recycle_app_pool`,
   `failover_to_replica`) — the real DBA fix is killing one specific
   session, and every existing type over-reaches. Resolved: build both —
   some SQL scenarios where killing the session is genuinely safe and newly
   allowed, and others where a real DBA correctly refuses to automate it.
   The user explicitly asked for more SQL scenarios specifically to
   demonstrate real DBA judgment, not just the one existing fixture case.
2. Execution always just restarts this process's own monitoring loop,
   regardless of what's approved. Making the *proposed* action source-aware
   without addressing this would create a new, worse honesty gap — it would
   look like different real actions execute, when they're secretly all the
   same stand-in. Resolved: keep the honest stand-in everywhere, but say so
   explicitly wherever it's shown or audited — no new infrastructure risk,
   no real write access added to SQL Server, IIS, or Docker in this pass.

## Decision

**The recommendation becomes real and DBA-informed; the execution stays an
explicitly-labeled simulation. The two are never conflated.**

### Real SQL DBA judgment, not a mapping table

`sqlRemediationSafety.ts`'s `assessBlockingSessionRemediation()` is pure,
deterministic, and — deliberately — the one recommendation decision in this
entire system that is never AI-decided, because it gates whether a real
production write (`kill_blocking_session`) is even offered. Three rules,
each a real, well-known DBA practice:

- **System session guard**: SQL Server reserves session_id ≤ 50 for
  internal system processes — never automated, regardless of how the
  blocking looks, since killing one risks breaking replication or a core
  server process.
- **Long-running-transaction guard**: a blocker running longer than 5
  minutes likely represents significant, hard-to-redo work. A real DBA
  investigates before killing it and forcing an expensive rollback.
- **Chained-blocker guard**: if the blocker is itself blocked by another
  session, killing it won't resolve anything — the real root cause is
  further up the chain.

`dmvFixtures.ts` now models 4 distinct real situations instead of one: the
original safe case (session 61/52), a long-running blocker (84/71, ~32
min), a system-session blocker (103/6), and a genuine 3-link chain
(130 → 118 → 95). 5 real SQL incidents total.

**The real, live-verified split is 2 safe, 3 requiring human judgment — not
the 1-safe/4-unsafe originally assumed, and the reason why is the more
interesting result.** Session 118's incident (blocked by 95) correctly
traces past its immediate blocker to the true root cause: assessing whether
it's safe to kill session 95 (not 118) finds 95 has no upstream blocker and
a short hold time — genuinely safe. Session 130 (blocked by 118) is
correctly flagged unsafe, because *its* immediate blocker, 118, is itself
chained to 95 — killing 118 wouldn't fix anything. This is the system
correctly distinguishing "the immediate blocker" from "the actual root
cause" across a real chain — more sophisticated, DBA-accurate behavior than
the flatter split originally planned, discovered by live-testing all 5
scenarios rather than assuming the design worked as sketched.

### Extending the allowlist — a real governance-boundary decision

`ALLOWED_ACTION_TYPES` gains `kill_blocking_session`. This list is the one
hardcoded boundary this system's entire blast-radius containment depends
on, so it was extended deliberately, by explicit user direction in review,
not decided alone. The reversibility argument: killing a session only rolls
back that session's own uncommitted transaction — touches no committed
data, affects no other session — the same reversibility class as the
existing four, not a step down in safety.

### Per-source mapping for the other three sources

SSRS gets `recycle_app_pool` — the textbook-correct real fix, since Report
Server genuinely runs under IIS in a real deployment. Cloud/SSIS gets
`restart_service` on `ssis-agent`; Docker gets `restart_service` on
`dev-superset`. No source, or an unrecognized one, falls back to the
original generic action — backward compatible with any caller that doesn't
send incident context.

### Execution stays the honest stand-in, made explicit everywhere

`stopMonitoringInternal()`/`startMonitoringInternal()` — the one real,
reversible thing this process can actually do — is unchanged code. What
changed is honesty about it: the execute response now carries `standInFor`
(`"kill_blocking_session on session 71 on OpsWarehouse"`, etc.), surfaced
in three places, not just one — the immediate activity feed line, the
`logEvent` operational log, and a new durable `recordSystemEvent` entry on
the real audit trail (previously `guardrail_executed` was operational-log
only, not durably audited at all — closed as part of making this honest,
not left half-done).

## Consequences

**What this closes:**
- 22 new/updated unit tests across `sqlRemediationSafety.test.ts` (11),
  `dmvReader.test.ts` (2, cap raised 3→15 so the fallback path's now-10 rows
  actually survive shaping — a real, necessary fix discovered during
  implementation, not anticipated in the original plan), and
  `remediationGuardrail.test.ts` (2). `mcp-server` 276/276,
  `guardrails` 69/69, `tsc --noEmit` clean.
- **A real bug found and fixed during live verification, not caught by unit
  tests**: the first implementation parsed the *blocked* session's id out of
  the incidentId and assessed *that* session's safety, instead of looking up
  its blocker first — every one of the 5 real incidents came back
  "chained blocker" on the first live test, since a blocked session's own
  row trivially has a non-zero `blocking_session_id` (itself). Unit tests
  passed throughout, because they exercised the pure function correctly in
  isolation — the bug was entirely in how `httpServer.ts` called it. Caught
  only by actually running all 5 real scenarios against the live server, not
  by code review or the test suite — the exact reason this session has
  treated live verification as required, not optional polish, throughout.
- A `NO_SAFE_ACTION` response path exists and is distinct from a genuine
  error — the dashboard renders it as an honest finding ("No safe automated
  remediation — session 71 has been running 32 minutes...") with no
  Approve/Reject offered, not a red error banner implying something broke.
- Live-verified fully end to end: all 5 SQL incidents produce the correct
  real response (2 propose `kill_blocking_session` on the correct target,
  3 return the correct, distinct `NO_SAFE_ACTION` reason); SSRS/Cloud/Docker
  each propose their real, source-correct action
  (`recycle_app_pool`/`ssrs-report-server`,
  `restart_service`/`ssis-agent`, `restart_service`/`dev-superset`); a real
  approve-and-execute round trip confirmed `standInFor` present in both the
  immediate response and the durable, persisted audit trail
  (`GET /api/audit?correlationId=`), and in the dashboard's activity feed at
  the moment of execution, not just in a log line no one would see live.

**What this explicitly does not cover:**
- Real execution differentiated by action type. Every approved action,
  including `kill_blocking_session`, still only restarts local monitoring —
  a deliberate scope decision, not an oversight, made directly with the
  user to avoid adding real write access to SQL Server/IIS/Docker without
  its own dedicated review.
- SSRS/Cloud/Docker actions do not have their own DBA-style safety
  assessment the way SQL does — they're a static, always-safe mapping,
  since none of those three sources has a real DBA judgment call analogous
  to "is this blocker safe to kill."

## What would change this decision

- **Real Docker execution** (the one source this process can plausibly and
  safely control locally, via the same Docker CLI already used for Superset
  warmup) would be the natural next real-execution candidate — discussed
  and deliberately deferred this pass, not rejected permanently.
- **Real SQL write access** would require a genuinely new, privileged
  connection this codebase has deliberately never had — every SQL
  interaction in this repo has been read-only DMV queries by design. Adding
  write access is a real security-posture change and belongs in its own
  dedicated review, not bundled into a remediation-mapping pass.
