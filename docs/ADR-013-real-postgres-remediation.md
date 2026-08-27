# ADR-013: A Second Real Execution Path — Real Postgres Blocking-Query Kill

**Status:** Implemented — built, unit-tested, and live-verified against a real blocked Postgres backend.
**Owner:** Quincy Nkwain Ninying
**Date:** 2026-08-27
**Component:** `mcp-server/dev-postgres/`, `mcp-server/src/pgActivitySource.ts`, `pgRemediationSafety.ts`, `pgRemediationExecutor.ts`, `incidentFeedService.ts`, `httpServer.ts`, `dashboard.html`

---

## Context

ADR-012 proved one real execution case: Docker/Superset restart. Asked what `verify-db` (the Postgres container backing Superset's SQL Lab demo, `mcp-server/dev-superset/docker-compose.yml`) is for, and whether to repurpose it for a second real-execution proof point.

**Two pushbacks shaped this decision, not just the build itself:**

1. **Renaming `verify-db` to "PostgreSQL" was rejected.** That's the product name, not a role — this repo names infrastructure by what it does (`dev-superset`, `ssis-agent`, `monitoring-collector`), never by the underlying technology alone.
2. **Repurposing `verify-db` itself was rejected.** It already has a real, working job — Superset's SQL Lab query target, seeded by `dev-superset/setup.sh` with fixed history that Act 5 of the demo (`verify-live-pattern.ts`) reads. Stopping it or holding a lock in it for a new incident scenario risks silently breaking that unrelated, already-working demo.

**A third option was considered and rejected too**: cloning the Docker case onto a second container (stop/restart a second Postgres instance). That would prove nothing new — the user's own framing was explicit that the point is demonstrating *judgment*, not just infrastructure control repeated. What got built instead is genuinely different in kind: a live database's own internal state (`pg_stat_activity`) reasoned over with the same class of DBA judgment `sqlRemediationSafety.ts` already applies to SQL Server, executing a real, parameterized SQL statement rather than a shell command.

## Decision

**A new, dedicated Postgres container** (`mcp-server/dev-postgres/docker-compose.yml`, service `orders-db`, database `orders`) — deliberately separate from `dev-superset/`'s `verify-db`, so this scenario's stop/lock/kill actions never share lifecycle with Superset's unrelated demo purpose.

**A real blocking scenario** (`seedPostgresBlockingScenario.ts`, mirroring `seedBlockingScenario.ts`'s SQL Server shape exactly): two real `pg` connections, one holds a row lock inside an open transaction, the other genuinely blocks on it in Postgres's own lock manager.

**Detection via Postgres's own built-in introspection** (`pgActivitySource.ts`): `pg_stat_activity` joined with `pg_blocking_pids(pid)` — Postgres exposes blocking-chain detection natively, where SQL Server's `dmvLiveSource.ts` has to compute it by hand from `dm_exec_requests`. No fixture-fallback concept, matching `supersetHealthSource.ts`'s reasoning: this is a fully local, fully-controlled dev container, not a remote server that can be legitimately unreachable.

**A real bug caught before it shipped, not after**: the query was originally written filtered to only rows that are themselves blocked (`WHERE pg_blocking_pids(pid) != '{}'`). That would have silently broken the common, safe case — a blocker that isn't itself blocked by anything never appears in a blocked-only result set, so `pgRemediationSafety.ts` would find no evidence for it and default to "not safe." Fixed by returning the broader row set (all real client backends) and filtering to blocked-only client-side in `incidentFeedService.ts`'s `discoverPostgresIncidents()` — the exact same split `discoverSqlIncidents()` already draws against `dmvLiveSource.ts`'s own unfiltered rows. Caught during implementation by tracing through the safe-case path by hand, the same discipline that caught ADR-010's session-vs-blocker bug during live testing.

**Real DBA judgment, translated not copied** (`pgRemediationSafety.ts`, mirroring `sqlRemediationSafety.ts`'s exact three-rule shape): a non-`client backend` `backend_type` (autovacuum, WAL sender, etc.) is never touched; a query running longer than 5 minutes is flagged for manual review, not killed blind; a blocker that's itself blocked points at the real root cause instead. Same thresholds as the SQL Server version, for consistency across the two.

**Real execution, confined to one file** (`pgRemediationExecutor.ts`): `SELECT pg_terminate_backend($1)`, parameterized, never string-interpolated — then an independent re-query of `pg_stat_activity` confirms the backend is actually gone, the same "don't trust the command succeeded, verify the outcome" discipline as `dockerExecutor.ts`'s health poll.

**A real structural guard, found and honestly extended, not routed around**: `readOnlyGuard.test.ts` already asserted no dependency here is SQL-write-capable without deliberate review — it's a live, enforced test for R2 (SQL-Server-specific read-only), not a comment. It already listed `pg` in `KNOWN_SQL_DRIVERS` (anticipated, unused) but never in `REVIEWED_SQL_DRIVERS`, since that list specifically means "confirmed read-only" — which `pg` isn't, by design. Rather than mark it falsely reviewed, `pg` was added to a new `DELIBERATELY_WRITE_CAPABLE_DRIVERS` list, and a new "pg write confinement" guard structurally asserts `pg_terminate_backend` appears in exactly one file (`pgRemediationExecutor.ts`) and nowhere else in `src/` — the same "provably narrow blast radius" discipline the original guard applies to "no write at all," adapted to "one confined, deliberate write."

**The shared real-execution response shape was generalized, not duplicated a second time.** ADR-012's Docker branch used Docker-specific field names (`confirmedHealthy`, `waitedMs`). Both real-execution branches in `httpServer.ts` now go through one shared `executeReal()` helper and populate `{ confirmed: boolean, detail: string }` — Docker's `detail` describes health confirmation, Postgres's describes backend termination — so `dashboard.html`'s rendering is one code path, not two that could quietly drift apart.

## Alternatives considered and rejected

- **A second Docker-restart clone** (stop/restart a second container). Rejected — proves nothing new beyond ADR-012.
- **Repurposing `verify-db`.** Rejected — real, working, unrelated demo purpose; coupling risk.
- **Renaming `verify-db` to "PostgreSQL."** Rejected — product name, not a role; this repo's own naming convention says otherwise.
- **Marking `pg` as reviewed-read-only in `readOnlyGuard.test.ts`.** Rejected — false; it's deliberately write-capable. The honest fix was a parallel, differently-scoped guard, not a lie inside the existing one.

## Consequences

**What this proves, live-verified, not just written:** a real blocking query in a real Postgres instance, detected via `pg_stat_activity`/`pg_blocking_pids()`, assessed with real DBA judgment, terminated via a real parameterized `pg_terminate_backend()` call, confirmed gone by an independent re-query — the second, differently-shaped proof that CoreOps can execute and verify a real remediation, not just simulate one.

**What this still doesn't cover:** SQL Server and SSRS/Cloud remain ADR-010's honest stand-in — nothing about their execution changed. A Postgres connection failure or a terminate that doesn't confirm surfaces as a real, honest failure/unconfirmed state, never a silent fallback to pretending. `verify-db`/`dev-superset/` is untouched by any of this — a fully separate container, fully separate lifecycle.

## What would change this decision

A third real execution candidate would need the same reversibility/blast-radius argument this ADR and ADR-012 both make — local, unprivileged, trivially reversible — before it's worth building. SQL Server and IIS still don't meet that bar in this environment.
