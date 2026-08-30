---
name: demo-start
description: Warm up SQL Server and Azure Blob Storage, start the CoreOps mcp-server HTTP server, and start continuous monitoring — everything needed before a live CoreOps demo, so the presenter never hits a cold-start delay or has to juggle terminal tabs mid-demo. Use when the user says "start the demo", "prep the demo", "warm everything up", or is about to record or present CoreOps.
---

# CoreOps Demo Start

Gets CoreOps into a demo-ready state: real dependencies warm, real server running,
real monitoring already active — so the presenter's first live action is triggering
the blocking scenario, not waiting on a cold start.

## Steps

1. **Check if the server is already running.** `curl -s http://localhost:8787/health`.
   If it responds `{"status":"ok"}`, skip to step 3 — don't start a second instance.

2. **Warm the external dependencies first**, from `mcp-server/`:
   ```
   npx tsx src/warmup.ts
   ```
   This can take up to ~90s if the free-tier SQL Server is paused — that's expected,
   not a failure, as long as it ends in "Both dependencies are warm and reachable."
   If it exits non-zero, stop here and report the actual failure message from the
   script — do not start the server against a dependency that isn't actually reachable.

3. **Start the HTTP server, under the demo supervisor, in the background**, from
   `mcp-server/`:
   ```
   DEMO_MODE=true node scripts/demoSupervisor.mjs > /tmp/coreops-demo.log 2>&1 &
   ```
   `DEMO_MODE=true` here is what enables `POST /api/demo/restart-server` (the
   dashboard's "Restart server (demo)" button, used for Beat 6) — it's set only as
   this one shell prefix, never written to `.env`, so a plain `npm run http` never
   exposes that route. The supervisor (`mcp-server/scripts/demoSupervisor.mjs`)
   relaunches the HTTP server automatically if it exits — which is what makes that
   button a real, working restart instead of a dead process — capped at 10
   restarts so a genuine crash loop still fails loud instead of looping forever.
   Then poll `curl -s http://localhost:8787/health` (a few seconds apart, bounded —
   don't wait forever) until it returns ok.

4. **Log in and capture a session cookie**, from `mcp-server/`. Every route past this
   point requires a real, password-verified session (see `mcp-server/src/auth/`) —
   `AUTH_USERNAME`/`AUTH_PASSWORD` must both be set in `mcp-server/.env` (the plaintext
   password, not just the hash, since a hash alone can't be used to log in). Extract
   just those two values with `grep`/`cut` rather than sourcing the whole `.env` file
   as shell code — confirmed by testing directly that blanket-sourcing breaks, since
   `OPERATOR_CONTACTS`'s unquoted value contains parentheses, which zsh tries to
   glob-expand:
   MFA is now real (TOTP, RFC 6238) — generate the current code fresh, right before
   the curl, rather than reusing an old one (the drift tolerance gives slack, but no
   reason to cut it close):
   ```
   AUTH_USERNAME=$(grep '^AUTH_USERNAME=' .env | cut -d= -f2-)
   AUTH_PASSWORD=$(grep '^AUTH_PASSWORD=' .env | cut -d= -f2-)
   TOTP_CODE=$(npm run current-totp-code --silent)
   curl -s -c /tmp/coreops-demo-cookies.txt -X POST http://localhost:8787/api/login \
     -H "Content-Type: application/json" \
     -d "{\"username\":\"$AUTH_USERNAME\",\"password\":\"$AUTH_PASSWORD\",\"totpCode\":\"$TOTP_CODE\"}"
   ```
   Confirm the response shows the real `"username"`, not a `401`. Every gated call
   below adds `-b /tmp/coreops-demo-cookies.txt`.

5. **Start continuous monitoring**, so it's already running before the presenter
   triggers anything:
   ```
   curl -s -b /tmp/coreops-demo-cookies.txt -X POST http://localhost:8787/api/monitoring/start
   ```
   Confirm the response shows `"running": true` and a real `taskId`.

6. **Schedule a real fault injection in the background**, so the demo starts clean
   and healthy and a real incident appears on its own partway through — the
   presenter never has to trigger anything on camera. Write a small wrapper script
   rather than backgrounding `sleep && seedBlockingScenario` directly — `$!` capture
   is unreliable when the command runs through a wrapped/sandboxed shell, confirmed
   by testing it directly: it captured the wrapper's own PID, not the real
   background job's. A named script file gives `pgrep -f`/`pkill -f` an unambiguous,
   collision-free target instead.
   ```
   cat > /tmp/coreops-fault-injector.sh <<'EOF'
   #!/bin/sh
   cd "<absolute path to mcp-server>"
   sleep "${1:-90}"
   npx tsx src/seedBlockingScenario.ts "${2:-60}"
   EOF
   chmod +x /tmp/coreops-fault-injector.sh
   nohup /tmp/coreops-fault-injector.sh 90 60 > /tmp/coreops-fault.log 2>&1 &
   disown
   ```
   Substitute the real absolute path to this repo's `mcp-server/` directory for
   `<absolute path to mcp-server>`. Defaults: the fault lands 90s after this step
   runs, then holds a real SQL Server lock for 60s before releasing it on its own.
   Those are the only two numbers (the two arguments to the script) — adjust them if
   the user asks for different timing (e.g. "2 minutes in" or "give me more time to
   explain it"). This runs the same real blocking scenario `seedBlockingScenario.ts`
   always creates (one session locks a row, a second blocks on it) — it's genuinely
   scheduled, not faked, and it resolves itself once the hold time elapses, which is
   the one honest "fix" this system can currently show: there is no real
   kill-session/restart-service execution path built yet (the guardrail correctly
   blocks that), so don't imply on camera that a button fixed it — the truthful
   narration is "the lock cleared" or "the system's own guardrail is why we can't
   just auto-fix this yet."

7. **Schedule a fresh cloud-diagnostics scenario in parallel**, same 90s default and
   same wrapper-script pattern as step 6 (a distinct wrapper path, so `demo-stop` can
   cancel this independently of the SQL fault injector) — this is what makes
   `/api/cloud-recommendation` (and the real "CoreOps: escalation" push notification
   it can trigger) show a genuinely different issue each demo instead of whatever
   static scenario was last uploaded to blob storage by hand:
   ```
   cat > /tmp/coreops-cloud-fault-injector.sh <<'EOF'
   #!/bin/sh
   cd "<absolute path to mcp-server>"
   sleep "${1:-90}"
   npx tsx src/seedCloudDiagnostics.ts
   EOF
   chmod +x /tmp/coreops-cloud-fault-injector.sh
   nohup /tmp/coreops-cloud-fault-injector.sh 90 > /tmp/coreops-cloud-fault.log 2>&1 &
   disown
   ```
   No scenario name is passed, so `seedCloudDiagnostics.ts` picks one at random from
   its five (SSIS slow load, SSRS render timeout, SQL Agent job failure, Windows disk
   critical, cloud storage latency) — deliberate, so consecutive demos don't line up
   on the same one. If the presenter wants a specific scenario instead (e.g. to match
   a specific narration beat), pass its name as the script's argument in place of
   nothing. This only refreshes the evidence in blob storage; nothing calls
   `/api/cloud-recommendation` on its own — the presenter (or a curl in the demo
   script) still triggers that live, same as any other route.

8. **Bring up `dev-postgres` and schedule a real Postgres blocking scenario**, so a
   genuine two-incident Postgres block (a stuck order update, a stuck payment
   update — see ADR-013 and `demo-postgres-incident`) appears on its own shortly
   after the presenter logs in, same "never trigger anything on camera" reasoning as
   steps 6-7. Idempotent container check first, same pattern as step 1:
   ```
   docker ps --filter "name=coreops-dev-postgres" --format "{{.Names}}"
   ```
   If that returns nothing, start it, from `mcp-server/dev-postgres/`:
   ```
   docker compose up -d
   ```
   Then schedule the seed script via the same named-wrapper-script pattern as steps
   6-7 (a distinct wrapper path, so `demo-stop` can cancel this independently):
   ```
   cat > /tmp/coreops-pg-fault-injector.sh <<'EOF'
   #!/bin/sh
   cd "<absolute path to mcp-server>"
   sleep "${1:-65}"
   npx tsx src/seedPostgresBlockingScenario.ts
   EOF
   chmod +x /tmp/coreops-pg-fault-injector.sh
   nohup /tmp/coreops-pg-fault-injector.sh 65 > /tmp/coreops-pg-fault.log 2>&1 &
   disown
   ```
   65s is the requested default — the fault lands 65s after this step runs (roughly
   "server up and the presenter has had time to log in," confirmed 2026-08-27 as the
   intended anchor). **No second argument, unlike step 6's SQL injector** —
   `seedPostgresBlockingScenario.ts` defaults to an effectively indefinite hold
   (1800s) by design, not a short one: two shorter fixed holds (90s, then 180s) were
   both confirmed live to self-resolve before a real presenter finished clicking
   through both incident cards. Don't pass a hold-seconds argument here unless the
   user explicitly wants a specific timed demonstration instead of "holds until
   Approve or cancel."

9. **Start the Superset stack**, for the reporting-service integration demo
   (`mcp-server/src/demoSsrsExecutionLog.ts` and
   `mcp-server/dev-superset/verify-live-pattern.ts` — see
   `project-blueprint/demo-script.md`'s Acts 4-5). Three possible states now that
   `demo-stop` stops rather than removes the containers (changed 2026-08-29) — check
   in this order, same idempotent-skip reasoning as step 1:
   ```
   docker ps --filter "name=coreops-dev-superset" --format "{{.Names}}"
   ```
   If that returns both `coreops-dev-superset` and `coreops-dev-superset-db`,
   already running — skip to step 10. Otherwise check whether they exist at all,
   just stopped:
   ```
   docker ps -a --filter "name=coreops-dev-superset" --format "{{.Names}}"
   ```
   If that returns both names, they exist from a prior session — just restart them,
   real query history and all, no re-init needed:
   ```
   docker start coreops-dev-superset-db coreops-dev-superset
   ```
   then poll `curl -s -o /dev/null -w "%{http_code}" http://localhost:8088/health`
   a few seconds apart (bounded) until it's healthy, and skip to step 10. Only if
   neither container exists at all (a genuinely first run, or one after
   `docker compose down -v` was used by hand) does this need the full init, from
   `mcp-server/dev-superset/`:
   ```
   ./setup.sh
   ```
   This starts Superset + Postgres, runs Superset's own migrations, and seeds one
   real successful query and one real failing query so `verify-live-pattern.ts` has
   genuine history to read — takes a real, noticeable amount of time (container
   pull if this is the first run, migrations, driver install), which is exactly why
   this belongs in prep, not triggered live on camera. Ends with "Done. Superset is
   running at http://localhost:8088" on success — if it doesn't, stop here and
   report the actual failure, same as step 2's warmup.

10. **Report readiness, don't open a browser tab yourself.** Tell the user the
   dashboard is ready at `http://localhost:8787/` and that they should open it in
   their own browser (the one they'll actually be screen-sharing) — the Claude Code
   Browser pane isn't what an audience sees. Mention that SQL Server may still take
   a little longer to fully warm on its very first real query even after step 2's
   direct check succeeds, since the app's own connection pool is separate from the
   warmup script's. Also state plainly when the scheduled faults (SQL blocking
   scenario, cloud-diagnostics scenario, and the Postgres blocking scenario — steps
   6, 7, and 8) will land, how long the SQL one holds, and that the Postgres one
   holds until Approved or cancelled (not on a timer), so the presenter can pace
   their narration against all three. Confirm Superset is up at
   `http://localhost:8088` (admin/admin, dev-only) and that Acts 4-5 are ready to
   run live, per step 9. Also mention that Beat 6 (proving the audit trail survives
   a real restart) now runs entirely from the dashboard's "Demo Evidence" panel —
   propose/approve a remediation first so it has a real correlation ID to show,
   then the "Restart server (demo)" button there does a genuine kill-and-relaunch
   live, no terminal needed.

## If something fails

Report the real error from whichever step failed — don't retry silently more than
once, and don't claim readiness if any step didn't actually succeed. A failed warmup
or a server that never returns healthy means the demo isn't ready yet; say so plainly.

## Related

- `demo-stop` — the matching teardown skill. It also cancels any fault injection
  step 6, step 7, or step 8 scheduled but hasn't fired yet, and kills it if it has
  (including an active Postgres block) — don't leave a scheduled or running
  blocking scenario, or a pending cloud-diagnostics seed, behind after the demo ends.
- `mcp-server/src/warmup.ts` — the actual warmup script this drives.
- `mcp-server/src/seedBlockingScenario.ts` — the real blocking-scenario script step 6
  schedules. Can still be run by hand instead, with different timing, if the
  presenter wants to trigger it live on camera rather than have it appear on its own.
- `mcp-server/src/seedCloudDiagnostics.ts` — the real cloud-diagnostics scenario
  script step 7 schedules. Can also be run by hand with a specific scenario name
  instead of a random one, same reasoning as `seedBlockingScenario.ts` above.
- `mcp-server/src/seedPostgresBlockingScenario.ts` — the real Postgres
  blocking-scenario script step 8 schedules (two scenarios, `orders` and
  `payments`). Holds effectively indefinitely by default — see its own file
  comment and `demo-postgres-incident`'s notes on why a fixed hold doesn't survive
  a real presenter's pace.
- `demo-postgres-incident` — the on-command sibling skill for triggering (and
  cancelling) this same scenario mid-demo instead of on a schedule. Its own notes
  on the identical-query-text bug and the fixed-hold-races-the-presenter bug apply
  here too, since step 8 schedules the same script.
- `mcp-server/src/auth/` — session auth. `demo-stop` re-logs in rather than assuming
  step 4's cookie jar is still valid (a demo can run past the 60-minute session TTL).
- `mcp-server/scripts/demoSupervisor.mjs` — the process supervisor step 3 launches
  the server under. Watches and relaunches the HTTP server on exit (capped at 10
  restarts), which is what makes `POST /api/demo/restart-server` (the dashboard's
  "Restart server (demo)" button) a real restart instead of a dead process.
- `mcp-server/dev-superset/` — the Superset + Postgres stack step 8 starts. Its own
  README explains what it is and, just as importantly, what it isn't: dev/verification
  tooling proving the live-query-then-fallback pattern works against a real running
  system, not a claim that Superset is CoreOps's actual reporting integration — that's
  `ssrsReader.ts`/`demoSsrsExecutionLog.ts`, which needs no Docker at all.
- `mcp-server/src/demoSsrsExecutionLog.ts` — the real SSRS reporting-service
  integration (Act 4). Doesn't depend on step 8 at all; only needs the same SQL
  Server connection step 2 already warms.
- `mcp-server/dev-superset/verify-live-pattern.ts` — the Superset pattern-verification
  script (Act 5). Depends on step 8; run it from inside `mcp-server/dev-superset/`,
  not with a root-relative path.
