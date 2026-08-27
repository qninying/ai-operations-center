---
name: demo-docker-incident
description: Trigger a real Superset/Docker-down incident for CoreOps live demos by stopping the dev-superset containers, and restore them afterward. Use when the user says "let's stop superset", "trigger the docker incident", "show the docker incident live", "bring superset back up", or wants to demo the Fix/Approve flow against a real Docker outage in front of an audience.
---

# CoreOps Docker Incident Demo

Stops (or restores) the real `coreops-dev-superset` / `coreops-dev-superset-db`
containers on command, mid-demo, so a genuine Docker-down incident appears in the
live dashboard within one poll cycle — the presenter then clicks Troubleshoot / Fix /
Approve themselves, in their own browser, in front of the audience. This is a live
infrastructure fault, not a simulated one: the incident feed detects real container
state (`mcp-server/src/incidentFeedService.ts`, polled every 3s server-side,
dashboard refreshes every 5s — so worst case ~8s to appear), and the proposed fix
(`restart_service` on `dev-superset`) is a real, source-mapped remediation
(ADR-010), not a hardcoded generic one.

**Separate from `demo-start`/`demo-stop`.** Those bookend a whole demo session (they
start/tear down the entire Superset stack via `setup.sh` / `docker compose down -v`).
This skill toggles the same already-running stack mid-demo, on command, without
touching the rest of the session (server, monitoring, other scheduled faults stay
untouched).

## Trigger the incident ("let's stop superset", "show the docker incident")

1. Check current state first — don't stop what's already stopped:
   ```
   docker ps --filter "name=coreops-dev-superset" --format "{{.Names}}: {{.Status}}"
   ```
   If nothing is listed, Superset is already down — say so, don't re-stop it, and go
   straight to step 3.

2. Stop both containers:
   ```
   docker stop coreops-dev-superset-db coreops-dev-superset
   ```
   Order doesn't matter for `stop` — the app container's state is what incident
   detection actually keys on.

3. Tell the user plainly: the incident should appear on **their own** dashboard
   within about 8 seconds (3s server poll + 5s UI refresh), titled "Superset
   (dev-superset stack) unreachable". Don't drive their browser for them and don't
   claim you saw it render — they're the one presenting on their own screen; your job
   stops at confirming the containers are actually down. If they ask you to confirm
   it registered server-side, you can check via an authenticated `/api/incidents`
   call only if you already have a valid, unexpired session cookie (see
   `demo-start` step 4 for how to get one) — don't guess or claim success you didn't
   verify.

## Restore Superset ("bring it back", "restore superset", "turn it back on")

1. Check current state first — don't start what's already running:
   ```
   docker ps --filter "name=coreops-dev-superset" --format "{{.Names}}: {{.Status}}"
   ```
   If both are already listed as `Up`, nothing to do — say so.

2. Start both containers:
   ```
   docker start coreops-dev-superset-db coreops-dev-superset
   ```

3. Poll until Superset itself reports healthy — a container can be `Up` and still
   booting, so don't declare it restored on `Up` alone:
   ```
   for i in $(seq 1 10); do
     st=$(docker inspect --format='{{.State.Health.Status}}' coreops-dev-superset 2>/dev/null)
     if [ "$st" = "healthy" ]; then break; fi
     sleep 6
   done
   ```
   Typically resolves within 20-30 seconds (confirmed live 2026-08-27: healthy on the
   2nd check, ~15s). If still not healthy after all 10 checks (~60s total), report
   that plainly rather than claiming success.

4. Tell the user the incident should clear from their dashboard's active list on its
   own within the same ~8s poll window — again, they confirm it visually, not you.

## What this proves, and what it doesn't

**Proves**: a genuine external-system failure is detected, diagnosed honestly (no
fake AI call for Docker — it's a plain connectivity check, and `troubleshootIncident`
says so), routed through ADR-010's real per-source remediation mapping, gated by the
"Awaiting your approval" flow, and resolved for real once the presenter approves and
the container is actually healthy again.

**Doesn't prove**: that clicking Approve itself restarts anything. Execution is still
the documented honest stand-in (`standInFor` in the audit log) — this environment has
no real write access to Docker control. Say so on camera if asked what Approve did.
The real container restart that resolves the incident is the one this skill performs
manually in step 2 above (Restore), not something the Approve button triggers.

## Related

- `demo-start` / `demo-stop` — the full-session bookends. Don't duplicate their
  Superset setup/teardown; this skill only toggles an already-running stack.
- `docs/ADR-010-sql-remediation-safety.md` — the source-aware remediation mapping
  that makes the Docker proposal (`restart_service` / `dev-superset`) real instead of
  a hardcoded generic action.
- `mcp-server/src/incidentFeedService.ts` — the real poll loop and interval this
  skill's timing claims are based on (`POLL_INTERVAL_MS = 3_000`).
