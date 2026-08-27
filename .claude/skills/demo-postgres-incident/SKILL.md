---
name: demo-postgres-incident
description: Trigger a real Postgres blocking-query incident for CoreOps live demos by seeding a genuine lock-contention scenario in the dev-postgres container, and cancel it early if needed. Use when the user says "let's block a Postgres query", "trigger the postgres incident", "show the postgres incident live", "seed a blocking query", or wants to demo the Troubleshoot/Fix/Approve flow against a real Postgres backend kill in front of an audience.
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

**A real demo bug found live, fixed 2026-08-27**: the first version of this seed
script used one `orders` table with a parameterized `WHERE id = $1` for both
scenarios — `pg_stat_activity`'s `query` column shows the literal SQL text sent
over the wire, not the bound value, so both incident cards rendered
byte-identical query text and looked like the same issue twice. Fixed with a
second, distinct table and literal (not parameterized) ids in the seed script's own
`UPDATE` text — safe there specifically because the ids come from a hardcoded
internal array, never user input. The default hold was also too short (90s) against
a real two-card click-through and was observed live to self-resolve mid-demo,
producing a confusing "no evidence found" on Fix — raised to 180s.

**Separate from `demo-docker-incident`.** Different container (`dev-postgres`, not
`dev-superset`), different mechanism (a seeded lock, not a stopped container),
different real execution (`pg_terminate_backend`, not `docker restart`). Both share
the same honesty discipline (execution and confirmation are separate steps; only a
confirmed outcome resolves the incident) but nothing else overlaps.

**Unlike Docker's fixed `docker:superset` id, this needs no recurrence fix.**
Postgres incident ids are `postgres:pid:${pid}` — a real OS-level process id, unique
to this one occurrence — so `markResolved()`'s permanent-suppression behavior never
causes the "can only fire once per server process" problem `demo-docker-incident`
had to work around (see that skill's own notes on the fix). A fresh seed always
produces a fresh, real pid.

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
   npx tsx src/seedPostgresBlockingScenario.ts "${1:-180}"
   EOF
   chmod +x /tmp/coreops-pg-blocking-seed.sh
   nohup /tmp/coreops-pg-blocking-seed.sh 180 > /tmp/coreops-pg-blocking-seed.log 2>&1 &
   disown
   ```
   Substitute the real absolute path to this repo's `mcp-server/` directory. 180
   seconds (3 minutes) is the script's own default — confirmed live 2026-08-27 that
   the original 90s default was too tight for a real two-card Troubleshoot/Fix
   click-through and self-resolved mid-demo; pass a different number as the script's
   argument if the user asks for more or less time ("give me five minutes" → 300).

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
   normally on its own row — the two scenarios are fully independent. Once both are
   approved (or their hold time elapses on its own), the script's process exits
   cleanly; if the script's remaining connections get killed by real terminations, it
   exits instead with an uncaught `FATAL: terminating connection due to
   administrator command` error per killed connection — expected, not a bug, and
   further proof each kill was real (confirmed live 2026-08-27). Nothing to clean up
   afterward either way; any killed connection is already gone.

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
  design this skill exercises.
- `mcp-server/src/seedPostgresBlockingScenario.ts` — the real seed script this skill
  schedules, now seeding 2 independent blocking pairs (4 connections total) instead
  of 1. Can be run by hand instead with a different hold time if the presenter wants
  to trigger it live on camera with specific timing.
