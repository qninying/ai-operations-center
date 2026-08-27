---
name: demo-stop
description: Stop the CoreOps mcp-server HTTP server and any monitoring it started for a demo, cleanly and idempotently. Use when the user says "stop the demo", "shut everything down", "kill the demo server", or is wrapping up after a CoreOps demo or rehearsal.
---

# CoreOps Demo Stop

Cleanly stops everything `demo-start` started. Safe to run even if nothing is
running — every step here is idempotent, matching this repo's own idempotency rule.

## Steps

1. **Cancel any scheduled or running fault injection first**, before it can fire
   after the demo has already ended — the SQL blocking scenario (`demo-start` step
   6), the cloud-diagnostics scenario (`demo-start` step 7), and the Postgres
   blocking scenario (`demo-start` step 8):
   ```
   pkill -f "coreops-fault-injector.sh" 2>/dev/null
   pkill -f "seedBlockingScenario.ts" 2>/dev/null
   pkill -f "coreops-cloud-fault-injector.sh" 2>/dev/null
   pkill -f "seedCloudDiagnostics.ts" 2>/dev/null
   pkill -f "coreops-pg-fault-injector.sh" 2>/dev/null
   pkill -f "coreops-pg-blocking-seed.sh" 2>/dev/null
   pkill -f "seedPostgresBlockingScenario.ts" 2>/dev/null
   ```
   Matches on each wrapper script's distinctive path, not a captured PID — `demo-start`
   deliberately doesn't rely on `$!` for this (confirmed unreliable in this
   environment: it captured the wrong process when tested directly). All these `pkill`s
   are safe to run even if nothing was scheduled — a no-op `pkill` just exits
   non-zero silently, which is the correct outcome here, not an error. This matters
   even if `demo-start`'s step 6, 7, or 8 already fired: killing an already-finished
   process's name match is harmless, and for Postgres specifically it matters even
   more than for SQL/cloud, since its scenario no longer expires on its own (see
   `demo-postgres-incident`'s notes) — an unkilled seed process here would otherwise
   keep a real lock held indefinitely after the demo has ended. Killing it releases
   the lock the same real way a genuine termination does (a lost connection, not a
   graceful commit).

2. **Log in fresh**, from `mcp-server/` — don't assume `demo-start`'s cookie jar is
   still valid (a demo can run past the session's 60-minute TTL, and re-logging in is
   cheap and stateless either way). Extract credentials with `grep`/`cut` rather than
   sourcing `.env` as shell code (see `demo-start`'s step 4 for why blanket-sourcing
   breaks). If the server isn't running, this will just fail to connect — that's fine,
   continue to step 3 rather than treating it as an error:
   MFA is now real (TOTP, RFC 6238) — generate the current code fresh, right before
   the curl:
   ```
   AUTH_USERNAME=$(grep '^AUTH_USERNAME=' .env | cut -d= -f2-)
   AUTH_PASSWORD=$(grep '^AUTH_PASSWORD=' .env | cut -d= -f2-)
   TOTP_CODE=$(npm run current-totp-code --silent)
   curl -s -c /tmp/coreops-demo-cookies.txt -X POST http://localhost:8787/api/login \
     -H "Content-Type: application/json" \
     -d "{\"username\":\"$AUTH_USERNAME\",\"password\":\"$AUTH_PASSWORD\",\"totpCode\":\"$TOTP_CODE\"}"
   ```

3. **Stop monitoring next, while the server can still hear the request:**
   ```
   curl -s -b /tmp/coreops-demo-cookies.txt -X POST http://localhost:8787/api/monitoring/stop
   ```
   If step 2's login failed (server not running), this will just fail to connect too
   — that's fine, continue to step 4 rather than treating it as an error.

4. **Stop the HTTP server process — via the supervisor, not the server directly.**
   `demo-start` now launches the server under `scripts/demoSupervisor.mjs`, which
   relaunches it automatically whenever it exits (that's what makes the dashboard's
   "Restart server (demo)" button work for Beat 6). Killing `tsx src/httpServer.ts`
   directly would just trigger an unwanted auto-restart — kill the supervisor
   instead, which stops watching before it kills its own child cleanly:
   ```
   pkill -f "demoSupervisor.mjs"
   ```
   If the server was ever started the old way (plain `npm run http`, no
   supervisor — e.g. outside this skill), fall back to
   `pkill -f "tsx src/httpServer.ts"` as well; harmless if nothing matches.

5. **Tear down the Superset stack**, if `demo-start`'s step 8 started it — its own
   README says plainly it's not meant to run unattended:
   ```
   cd mcp-server/dev-superset && docker compose down -v && cd -
   ```
   Safe to run even if nothing is up — `docker compose down` on an already-stopped
   or never-started stack is a no-op, same idempotent-by-default reasoning as the
   `pkill`s in step 1. Removes the containers, network, and volume together (`-v`),
   so a later `demo-start` gets a genuinely fresh Superset init rather than reusing
   stale state.

6. **Confirm it's actually down**, don't just assume the kill worked:
   ```
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/health
   ```
   A `000` confirms nothing is listening on port 8787 anymore. If it still responds,
   something else is holding the port or the process didn't die — investigate rather
   than reporting success.

7. **Report the clean state.** Confirm to the user that any pending fault injection
   was cancelled, monitoring was stopped, the HTTP server is down, and the Superset
   stack was torn down — don't leave them wondering whether something is still
   running in the background after they've closed their laptop.

## Related

- `demo-start` — the matching setup skill. Step 9 there starts the Superset stack
  this skill's step 5 tears down; step 8 schedules the Postgres blocking scenario
  this skill's step 1 cancels.
- `mcp-server/dev-superset/` — its own README explains why this teardown matters:
  dev/verification tooling, explicitly not meant to be left running.
- `mcp-server/dev-postgres/` — the Postgres container `demo-start` step 8 may start.
  Not torn down by this skill (deliberately, same as `demo-postgres-incident`'s own
  scope decision) — only the fault-injector process and any active block are
  cancelled in step 1; the container itself is left running between demos.
- `mcp-server/scripts/demoSupervisor.mjs` — the process step 4 stops. Also stops
  itself cleanly (kills its own child, no auto-restart) on SIGTERM, so a plain
  `pkill -f "demoSupervisor.mjs"` is enough — no separate step needed for the
  server it's watching.
