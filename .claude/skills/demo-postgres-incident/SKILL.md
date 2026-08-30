---
name: demo-postgres-incident
description: Trigger a real Postgres incident for CoreOps live demos — either a genuine lock-contention scenario in the dev-postgres container, or the container itself going unreachable (added 2026-08-28, mirroring demo-docker-incident) — and cancel/restore it. Use when the user says "let's block a Postgres query", "trigger the postgres incident", "show the postgres incident live", "seed a blocking query", "stop dev-postgres", "make postgres unreachable", or wants to demo the Troubleshoot/Fix/Approve flow against a real Postgres backend kill or a real container restart in front of an audience.
---

# CoreOps Postgres Incident Demo

Seeds 2 real, independent, genuinely different-looking blocking queries in the
dedicated `dev-postgres` container on command, mid-demo — a stuck order update and
a stuck payment update, not the same query twice — matching the "2 incidents per
source" shape SQL/SSRS's fixture data also uses (trimmed 2026-08-27). The presenter
then clicks Troubleshoot / Fix / Approve on each themselves, in their own browser,
in front of the audience, and CoreOps runs a real `pg_terminate_backend()` per
approval. This is a live database lock, not a simulated one: two real `pg`
connections contend for the same row on each of two separate tables (`orders`,
`payments`), detected via `pg_stat_activity`/`pg_blocking_pids()` (polled every 3s
server-side, dashboard refreshes every 5s), and the proposed fix
(`kill_postgres_backend`) is gated by real DBA judgment (`pgRemediationSafety.ts`,
ADR-013) before it's ever offered.

**Two real demo bugs found live, fixed 2026-08-27**: the first version of this seed
script used one `orders` table with a parameterized `WHERE id = $1` for both
scenarios — `pg_stat_activity`'s `query` column shows the literal SQL text sent
over the wire, not the bound value, so both incident cards rendered
byte-identical query text and looked like the same issue twice. Fixed with a
second, distinct table and literal (not parameterized) ids in the seed script's own
`UPDATE` text — safe there specifically because the ids come from a hardcoded
internal array, never user input.

Separately, a fixed hold duration turned out to be fundamentally the wrong shape
for a live demo: 90s, then a "generous" 180s, **both** confirmed live 2026-08-27 to
self-resolve before a real presenter finished clicking through two incident cards
(read Troubleshoot, click Fix, read the result, repeat) — producing a confusing but
technically honest "no evidence found" on Fix once the block had already cleared
itself. No fixed number reliably survives a real presenter's pace. **Fixed by
removing the auto-expiry**: the script now holds effectively indefinitely by
default (1800s / 30 min, a forgotten-process safety net, not a demo budget) — the
scenario ends only when a real Approve kills it (the intended, natural ending) or
the cancel step below is used. Don't suggest picking "a bigger number" if this
class of bug resurfaces; the fix is no ticking clock at all, not a longer one.

**Separate from `demo-docker-incident`.** Different container (`dev-postgres`, not
`dev-superset`), different mechanism (a seeded lock, not a stopped container),
different real execution (`pg_terminate_backend`, not `docker restart`). Both share
the same honesty discipline (execution and confirmation are separate steps; only a
confirmed outcome resolves the incident) but nothing else overlaps.

**Unlike Docker's fixed `docker:superset` id, the blocking-query scenario below
needs no recurrence fix.** Postgres incident ids for a real block are
`postgres:pid:${pid}` — a real OS-level process id, unique to this one
occurrence — so `markResolved()`'s permanent-suppression behavior never causes the
"can only fire once per server process" problem `demo-docker-incident` had to work
around (see that skill's own notes on the fix). A fresh seed always produces a
fresh, real pid. **The container-unreachable scenario added below is the one
exception** — `postgres:unreachable` is a fixed, non-timestamped id, exactly like
`docker:superset`, so it *does* rely on the same recurrence handling
`incidentFeedService.ts` already has for Docker (un-suppressed once it stops being
discovered at all) — added 2026-08-28 alongside the incident itself, covered by its
own test.

## Trigger the unreachable incident ("stop dev-postgres", "make postgres unreachable")

Mirrors `demo-docker-incident`'s stop/restore steps exactly, second container — a
real `docker stop`/`start`, not a seeded lock. Detection (`postgres:unreachable`)
and the real restart-and-confirm remediation were added 2026-08-28
(`docs/ADR-012-real-docker-execution.md`'s addendum) specifically so this is a
genuine, repeatable on-command demo beat, not just a blocking-query one.

1. Check current state first — don't stop what's already stopped:
   ```
   docker ps --filter "name=coreops-dev-postgres" --format "{{.Names}}: {{.Status}}"
   ```
   If nothing is listed, it's already down — say so, don't re-stop it.

2. Stop the container:
   ```
   docker stop coreops-dev-postgres
   ```

3. Tell the user plainly: the incident should appear on **their own** dashboard
   soon, titled "Postgres (dev-postgres) unreachable" — same timing caveat as
   `demo-docker-incident` (immediate outside demo mode; a randomized 3-45s reveal
   delay under `DEMO_MODE=true`). Don't drive their browser for them or claim you
   saw it render.

### Restore ("bring postgres back", "restore dev-postgres")

1. Check current state first:
   ```
   docker ps --filter "name=coreops-dev-postgres" --format "{{.Names}}: {{.Status}}"
   ```
   If already `Up`, nothing to do.

2. Start it:
   ```
   docker start coreops-dev-postgres
   ```
   Confirm it's genuinely accepting connections, not just `Up` —
   `docker exec coreops-dev-postgres psql -U app -d orders -c "SELECT 1;"` — typically
   ready within a couple seconds (Postgres boots far faster than Superset).

3. Tell the user the incident should clear from their dashboard's active list on its
   own within one poll cycle — same as Docker's restore step, they confirm visually,
   not you.

**Real execution, same as Docker's**: approving the proposed fix on this incident
runs a genuine `docker restart coreops-dev-postgres` (`restartPostgresContainer()`
in `dockerExecutor.ts`) and independently reconfirms the container is actually
reachable before the incident is allowed to show as resolved — not the ADR-010
honest stand-in every other non-Docker/Postgres action still uses.

## Trigger the incident ("let's block a postgres query", "trigger the postgres incident")

1. Make sure `dev-postgres` is actually up — don't assume it's already running:
   ```
   docker ps --filter "name=coreops-dev-postgres" --format "{{.Names}}"
   ```
   If that returns nothing, start it, from `mcp-server/dev-postgres/`:
   ```
   docker compose up -d
   ```
   Wait a couple seconds and confirm with the same `docker ps` check before moving on
   — a container that's still initializing can't take real connections yet.

2. **Seed both real blocking scenarios in the background, via a named wrapper script**
   (one script call seeds both — `seedPostgresBlockingScenario.ts` runs the order
   and payment blocking pairs concurrently),
   not a bare backgrounded `tsx` call — `$!` capture is unreliable in this sandboxed
   shell (confirmed directly by `demo-start`'s own fault-injector steps for the same
   reason), and a named script gives `pgrep -f`/`pkill -f` an unambiguous target for
   the cancel step below:
   ```
   cat > /tmp/coreops-pg-blocking-seed.sh <<'EOF'
   #!/bin/sh
   cd "<absolute path to mcp-server>"
   npx tsx src/seedPostgresBlockingScenario.ts "${1:-1800}"
   EOF
   chmod +x /tmp/coreops-pg-blocking-seed.sh
   nohup /tmp/coreops-pg-blocking-seed.sh 1800 > /tmp/coreops-pg-blocking-seed.log 2>&1 &
   disown
   ```
   Substitute the real absolute path to this repo's `mcp-server/` directory. 1800
   seconds (30 min) is the script's own default and is meant as a forgotten-process
   safety net, not a demo timer — two shorter fixed defaults (90s, then 180s) were
   both confirmed live to race a real presenter and self-resolve mid-demo. The
   scenario is meant to hold until Approve kills it or the cancel step below is used,
   not to time out. Only pass a shorter number if the user explicitly wants a
   specific timed demonstration instead.

3. Tell the user plainly: the incident should appear on **their own** dashboard soon
   — timing depends on demo mode, same as `demo-docker-incident` (immediate outside
   demo mode; a randomized 3-45s reveal delay under `DEMO_MODE=true`, which is how
   `demo-start` launches the server). Don't drive their browser for them and don't
   claim you saw it render. If they ask you to confirm it registered server-side, you
   can check via an authenticated `/api/incidents` call only if you already have a
   valid, unexpired session cookie (see `demo-start` step 4) — or confirm the real
   lock directly: `SELECT pid, pg_blocking_pids(pid) FROM pg_stat_activity WHERE
   pg_blocking_pids(pid) != '{}'` against `dev-postgres` (host `localhost`, port
   `5434`, db `orders`, user/password `app`/`app`).

4. **The demo's natural ending is the presenter clicking Approve on each of the two
   incidents** — every approval runs a real `pg_terminate_backend()` on that
   blocker, which kills that specific Session A connection out from under it.
   Approving just one still leaves the seed script's other Session A/B pair running
   normally on its own row — the two scenarios are fully independent. Each real
   termination makes the script exit with an uncaught `FATAL: terminating
   connection due to administrator command` error for that connection — expected,
   not a bug, and further proof the kill was real (confirmed live 2026-08-27).
   Nothing to clean up afterward; the killed connection is already gone. If neither
   incident is approved, the scenario just keeps holding (see the 1800s note above)
   until the cancel step below is used — it will not silently expire mid-demo.

## Cancel early ("stop the postgres demo", "cancel the blocking query", never reached Approve)

If the presenter doesn't go through Fix/Approve and wants to end the scenario
without waiting out the full hold time:

```
pkill -f "coreops-pg-blocking-seed.sh"
pkill -f "seedPostgresBlockingScenario.ts"
```

Killing the script's process kills all of its Postgres connections at once — both
scenarios cancel together, since one script process holds both pairs — which
Postgres itself detects as lost connections and rolls back each open transaction —
both locks release on their own, the same real mechanism as a graceful commit, just
abrupt. Both `pkill`s
are safe to run even if nothing is scheduled (a no-op `pkill` just exits non-zero
silently). Confirm it actually cleared if asked:
```
docker exec coreops-dev-postgres psql -U app -d orders -c \
  "SELECT pid FROM pg_stat_activity WHERE pg_blocking_pids(pid) != '{}';"
```
An empty result confirms no blocking backend remains.

## What this proves, and what it doesn't

**Proves**: a genuine row-lock contention is detected via Postgres's own real
introspection (`pg_stat_activity`/`pg_blocking_pids()`), diagnosed honestly (no AI
call for Postgres either — `troubleshootIncident()` says so directly, same pattern
as Docker), assessed by real, deterministic DBA judgment
(`pgRemediationSafety.ts`), and — once approved — actually resolved by a real
`pg_terminate_backend()` call, independently reconfirmed against `pg_stat_activity`
before the incident is allowed to show as resolved.

**Doesn't prove**: that every blocking query is safe to auto-kill. The seeded
scenario here is deliberately the simple, safe case (a short-lived client backend,
no system process, no chain) — `pgRemediationSafety.ts`'s other rules (a long-running
query, a system backend, a chained blocker) are covered by its own unit tests and by
`ADR-013`'s live break test against a real Postgres background worker, not by this
seed script.

## Related

- `demo-docker-incident` — the sibling skill for the Docker/Superset real-execution
  case. Same demo shape, different container, different mechanism.
- `demo-start` / `demo-stop` — the full-session bookends. Don't currently manage
  `dev-postgres/`'s lifecycle (unlike `dev-superset/`, which `demo-start` step 8
  starts) — start/stop it directly as this skill's own step 1 describes, or extend
  `demo-start`/`demo-stop` separately if `dev-postgres` should become part of every
  demo session by default.
- `docs/ADR-013-real-postgres-remediation.md` — the real DBA judgment and execution
  design the blocking-query scenario exercises.
- `docs/ADR-012-real-docker-execution.md` — its 2026-08-28 addendum covers the
  unreachable/restart scenario above; `mcp-server/src/dockerExecutor.ts`'s
  `restartPostgresContainer()` is the real execution it calls.
- `mcp-server/src/seedPostgresBlockingScenario.ts` — the real seed script this skill
  schedules, now seeding 2 independent blocking pairs (4 connections total) instead
  of 1. Can be run by hand instead with a different hold time if the presenter wants
  to trigger it live on camera with specific timing.
