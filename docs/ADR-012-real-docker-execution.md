# ADR-012: One Real Execution Path — Docker/Superset Restart

**Status:** Implemented — built, unit-tested, and live-verified against a real Docker container.
**Owner:** Quincy Nkwain Ninying
**Date:** 2026-08-27
**Component:** `mcp-server/src/dockerExecutor.ts`, `mcp-server/src/httpServer.ts`, `mcp-server/src/dashboard.html`

---

## Context

ADR-010 established the core execution honesty principle this codebase has followed ever since: the *recommendation* CoreOps proposes is real and source-specific, but *execution* has always been one deliberately-labeled stand-in (`stopMonitoringInternal()`/`startMonitoringInternal()`) — no real write access to SQL Server, IIS, or Docker was ever wired in, and every executed response carries a `standInFor` field saying so plainly.

Asked directly for one deliberate, narrow exception: "its out of scope but i need to prove im not just plumbering — i do have one proved evidence coreops fixed an incident by a click of a button." Explicitly framed as a single, intentional scope expansion — not a request to make every source's execution real.

## Decision

**Docker/Superset, and only Docker/Superset, executes for real.** It is the one target this environment already has direct, unprivileged control over: `docker restart coreops-dev-superset` needs no new credential, touches no production system, and is trivially reversible — a local dev container the operator already owns outright, with zero data-loss risk. SQL Server write access and real IIS/SSIS control would each need a genuinely new privileged connection this codebase has deliberately never had (flagged as a real, separate decision in ADR-010's own PROGRESS.md note) — that door stays closed here.

**Execution and confirmation are two separate steps, and only a confirmed recovery resolves the incident.** This is the one thing that could not slip: claiming a real restart happened and the incident is fixed, without independently confirming it, would be a second "looks real but isn't" gap in the opposite direction from ADR-010's — a false "fixed" is worse than an honest "not yet confirmed." `restartSupersetContainer()` (`mcp-server/src/dockerExecutor.ts`) therefore returns `{ attempted: true, confirmedHealthy: boolean, waitedMs: number }`, never just `{ executed: true }`, and the dashboard only calls `resolveIncident()` when `confirmedHealthy` is true. This mirrors the Resolved panel's own pre-existing "Did this actually fix it? Confirm resolved · Recurred" check — an automated version of the same honesty question this codebase already asks a human to answer for every other fix.

**A deliberately separate health probe, not `checkSupersetHealth()`.** `supersetHealthSource.ts`'s health check shares one module-level `CircuitBreaker` with `incidentFeedService.ts`'s own polling loop (confirmed via `supersetHealthSource.test.ts`: 5 failures in a 60s window opens it for a 30s cooldown). Immediately after a restart, several early polls are *expected* to fail while the container boots — reusing that breaker risks tripping it and then being blocked by its own cooldown exactly when a fast, frequent answer is needed. `dockerExecutor.ts` polls `http://localhost:8088/health` directly instead, every 3s up to a 45s ceiling (real observed recovery has been ~5–15s; 45s leaves real margin without an unbounded wait, per this repo's own `CLAUDE.md` rule).

**No shell, no injection surface.** `execFile("docker", ["restart", "coreops-dev-superset"])` — a fully fixed command and argument array, no `shell: true`, nothing derived from user input at all. Wrapped in the existing `reliability/withReliability.ts` for an explicit ~15s timeout (`maxRetries: 0` — a single bounded attempt, not blind retries of a command that already ran).

**Gated behind the exact same guardrail path as every other action.** This is not a new door into execution — it's the same `POST /api/guardrail/decide` handler, after the same evidence check, the same HITL approval, the same `checkRemediationGuardrail()` allowlist check. Only the branch matched on `actionType === "restart_service" && targetSystem.name === "dev-superset"` (the exact pairing ADR-010's `SOURCE_ACTIONS.docker` already produces) diverges into real execution; every other action/source falls through to ADR-010's stand-in, byte-for-byte unchanged.

## Alternatives considered and rejected

- **Make execution real for SQL/SSRS/Cloud too.** Rejected outright, per the user's own framing — this is one proof point, not a general policy change. None of those three has any real credentialed write access in this codebase today, and building that would each be its own large, separate decision (a new privileged SQL Server connection, real IIS app-pool control, real SSIS agent control) — not something to bundle into proving one Docker case.
- **Silently falling back to the stand-in if the real restart fails.** Rejected — that would recreate exactly the honesty gap this whole session has worked to eliminate: an execution failure (daemon unreachable, container renamed/removed) surfaces as a real, visible failure (`DOCKER_RESTART_FAILED`, red "Restart failed" banner), never quietly disguised as a successful stand-in.
- **Reusing `checkSupersetHealth()` for post-restart polling.** Rejected for the shared-circuit-breaker contamination reason above — a separate, minimal probe was cheaper and safer than adding configurability to the shared one.

## Consequences

**What this proves, live-verified, not just written:** a real container restart, driven end-to-end by a human clicking Approve in the dashboard — the container genuinely transitions from `Exited` to `Up`/`healthy` (confirmed via `docker inspect`, not just the API response), the incident clears from the active list only once that's true, and the durable audit log carries `realExecution: true, confirmedHealthy: true`.

**What this still doesn't cover:** SQL, SSRS, and Cloud remain ADR-010's honest stand-in — nothing about their execution changed. A Docker daemon outage or a removed/renamed container surfaces as a real, honest failure (`DOCKER_RESTART_FAILED`), never a silent fallback to pretending. The DB companion container (`coreops-dev-superset-db`) is untouched by this action — the incident this resolves is specifically "Superset unreachable," which the app container's health alone determines.

## What would change this decision

Extending real execution to any other source would need its own dedicated review of the new privileged access it requires — the exact reversibility/blast-radius argument this ADR makes for Docker (local, unprivileged, trivially reversible) does not automatically transfer to SQL Server or IIS.
