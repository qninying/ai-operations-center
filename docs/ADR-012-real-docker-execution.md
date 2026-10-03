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

## Addendum (2026-08-28): dev-postgres joins as a second target

For a live-demo capability — manually stopping `dev-postgres`/`dev-superset` mid-demo
to show CoreOps genuinely detect and alert on it — `dev-postgres` needed the same
treatment Docker already had: detection of "unreachable" as a real incident of its
own (not just "can't check this source"), and a real restart, not a stand-in. This
is not a new decision, the exact reasoning above already covers it: `dev-postgres`
is the same class of target as `dev-superset` — a local dev container this
environment already owns outright, `docker restart coreops-dev-postgres` needs no
new credential, touches no production system, is trivially reversible.

`dockerExecutor.ts`'s restart-then-confirm mechanism was generalized to take a
container name and a health-probe function, rather than duplicated — Superset's
probe stays an HTTP health check; Postgres's is a direct `pg` connect + `SELECT 1`,
deliberately separate from `pgActivitySource.ts`'s own circuit breaker for the same
reason Superset's probe stays separate from `supersetHealthSource.ts`'s. Wired
through the identical `POST /api/guardrail/propose`/`decide` path, reusing the same
`restart_service` action type (no new action type, no guardrail change) — only
`targetSystem.name` differs (`dev-postgres` vs `dev-superset`), and the response
shape (`executed`, `realExecution`, `realOutcome: { confirmed, detail }`) is
byte-for-byte the same generic shape `dashboard.html` already renders for both.

Detection required one deliberate exception to `incidentFeedService.ts`'s general
"unreachable = can't check, not a finding" policy — `discoverPostgresIncidents()`
now returns a real `postgres:unreachable` incident (a fulfilled result, mirroring
`discoverDockerIncidents()`'s catch branch exactly) instead of re-throwing. This
means a container-down event correctly *replaces* any active blocking-query
incident as the one real problem to report, the same way Docker's single fixed id
already works — covered by a new test (`incidentFeedService.test.ts`) asserting
exactly that replacement, not just the detection in isolation.

## Addendum (2026-10-03): a second target, pointed at prod

A real gap, named honestly rather than left implicit: everything above only ever
worked when `mcp-server` itself runs locally, on the same machine as the Docker
daemon and the two dev containers. The production instance at `coreops.fly.dev`
has no Docker daemon and can't reach a laptop's `localhost` — so the live-demo
incident capability this ADR describes has never actually been exercised against
the real deployed app, only against a local dev server.

**Decision: add a second target, not replace the first.** `DEMO_TARGET` (default
`"local"`, unset changes nothing) switches `pgActivitySource.ts`,
`supersetHealthSource.ts`, and `dockerExecutor.ts` to point at Fly-hosted
`dev-postgres`/`dev-superset` sidecar apps on Fly's private 6PN network instead
of `localhost` — see `mcp-server/src/demoTargetConfig.ts`, the single module
all three now resolve host/URL/restart-target through, so they can't drift
against each other the way two independent copies of this logic would.

**Restart goes through the Fly Machines API, not `execFile("docker", ...)`.**
`mcp-server/src/flyMachinesExecutor.ts` is the prod counterpart to this ADR's
local `docker restart` call — a plain authenticated `POST .../machines/<id>/restart`
against Fly's REST API, wrapped in the same `withReliability` timeout/single-
attempt shape as the local path. `dockerExecutor.ts`'s `restartContainerAndConfirm`
branches on which `RestartTarget` it was given; the restart-then-poll-health
structure, and the `{ attempted, confirmedHealthy, waitedMs }` return contract,
are identical either way — callers in `httpServer.ts` needed zero changes.

**Two tokens, not one.** `fly tokens create deploy` only ever scopes to a single
app (`-a <app>` is not repeatable), so there is no single-token way to cover both
sidecar apps — `FLY_DEV_POSTGRES_API_TOKEN` and `FLY_DEV_SUPERSET_API_TOKEN` are
separate, each scoped to just its own app. This is a real new credential either
way, unlike local `docker restart`'s "no credential at all" — the exact
blast-radius argument this ADR's original Decision section makes for Docker does
not transfer automatically to a Fly API token, which is why each one is scoped
as narrowly as Fly's own tooling allows rather than issued as one broad token.

**Not done in this addendum:** the two Fly apps have not actually been
provisioned, and no real token/machine ID has been generated or deployed —
this addendum covers the code-side switch only (unit-tested: `demoTargetConfig.test.ts`,
`flyMachinesExecutor.test.ts`, and new `DEMO_TARGET=prod` cases in
`dockerExecutor.test.ts`, 408/408 passing, `tsc --noEmit` clean). Provisioning the
actual Fly apps, generating the two scoped tokens, and live-verifying a real
restart against them is a separate, deliberate next step — a real infra change
and a real new paid resource, not bundled into this code change.

## Addendum (2026-10-03, same day): provisioned for real, with one genuine open finding

`dev-postgres` and `dev-superset` are now real, running Fly apps (region `iad`,
matching `coreops`), each a single machine (`postgres:16-alpine`,
`apache/superset:latest`), deployed via `fly deploy --image ...` with a
`fly.toml` `[[services]]` block rather than a bare `fly machines run` —
necessary, not cosmetic: a bare machine's raw per-machine 6PN address
(`<app>.internal`) only answers if the process inside binds a reachable
interface for that path, and the first real test against both apps got
"connection refused" from a sibling app every time, networking confirmed
fine (`nc`/DNS both correct). The actual fix was `fly ips allocate-v6
--private` (a flycast private address) plus the `[[services]]`/`[[services.ports]]`
block, then reaching each sidecar via **`<app>.flycast`, not `<app>.internal`**
— flycast is the proxied private address Fly's own edge translates through;
`.internal` is the raw unproxied machine-to-machine path and was never going
to work here. `demoTargetConfig.ts`'s env vars (`PG_PROD_HOST`,
`SUPERSET_PROD_URL`) are just strings, so this didn't need a code change —
only the value set on coreops's secrets (`dev-postgres.flycast`,
`http://dev-superset.flycast:8088`).

A second real issue, also found live: `dev-superset`'s first machine (512MB)
had its gunicorn worker OOM-killed in a loop (confirmed in `fly logs -a
dev-superset`: repeated `Out of memory: Killed process ... (gunicorn)`, one
cycle severe enough to reboot the whole VM) — Superset's default worker
needs more than 512MB to boot stably. Resized to 2048MB (`fly machine update
... --vm-memory 2048`); no further OOM after that.

**Verified for real, each independently, not inferred from "it deployed":**
- Raw TCP reachability, sidecar-to-sidecar and from `coreops` itself, to both
  `.flycast` addresses (`nc -zv`, exit 0).
- The exact Postgres connection `pgActivitySource.ts` makes (same host, port,
  database, user, password), run from inside `coreops` via an inline Node
  script, not simulated: `SUCCESS [{"?column?":1}]`.
- The exact Superset health check `supersetHealthSource.ts` makes, same way:
  `SUCCESS OK`.
- The real restart mechanism `flyMachinesExecutor.ts` uses: called
  `POST .../apps/dev-postgres/machines/<id>/restart` directly against Fly's
  live API with the real scoped token — `{"ok":true}`, HTTP 200 — then
  confirmed in `dev-postgres`'s own logs that Postgres genuinely shut down
  and restarted (not a no-op): `database system is shut down` followed by a
  fresh `database system is ready to accept connections` with a new
  timestamp, and the machine's `LAST UPDATED` field changed accordingly.

**A genuine open finding, not yet resolved:** with `DEMO_TARGET=prod` live on
`coreops`'s own secrets, the production incident feed's `postgres` and
`docker` (Superset) source checks have been failing continuously
(`CircuitOpenError`) since shortly after the redeploy, for several minutes
with no self-recovery observed, **despite the underlying connection working**
exactly as the three direct tests above prove. Root cause not fully isolated
live: `incidentFeedService.ts`'s two catch blocks (`discoverDockerIncidents`,
`discoverPostgresIncidents`) log only `errorClass`, never the underlying
`message`/`cause` — the exact gap `dmvReader.ts` already had fixed earlier
this session, not yet applied here, which made this genuinely undiagnosable
from logs alone. The leading theory, from reading `withReliability.ts`
directly: `checkAvailability()` is re-checked on every retry attempt inside
one call, so a half-open trial that fails for any real reason reopens the
breaker *mid-call*, and the next attempt's `CircuitOpenError` is what
propagates outward — masking the real failure as "circuit open" indefinitely
rather than surfacing the actual cause once. Not fixed in this addendum: it's
pre-existing reliability-layer code, not part of today's change, and
touching it is a deliberate separate decision, not bundled in here.
Restarting `coreops` itself (which would reset the in-memory breaker and
might simply resolve this) was not done either — a production machine
restart is outside what this session took without the user's own call on it.
