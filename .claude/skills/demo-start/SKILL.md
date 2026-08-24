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

3. **Start the HTTP server in the background**, from `mcp-server/`:
   ```
   npm run http > /tmp/coreops-demo.log 2>&1 &
   ```
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
   ```
   AUTH_USERNAME=$(grep '^AUTH_USERNAME=' .env | cut -d= -f2-)
   AUTH_PASSWORD=$(grep '^AUTH_PASSWORD=' .env | cut -d= -f2-)
   curl -s -c /tmp/coreops-demo-cookies.txt -X POST http://localhost:8787/api/login \
     -H "Content-Type: application/json" \
     -d "{\"username\":\"$AUTH_USERNAME\",\"password\":\"$AUTH_PASSWORD\"}"
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

7. **Report readiness, don't open a browser tab yourself.** Tell the user the
   dashboard is ready at `http://localhost:8787/` and that they should open it in
   their own browser (the one they'll actually be screen-sharing) — the Claude Code
   Browser pane isn't what an audience sees. Mention that SQL Server may still take
   a little longer to fully warm on its very first real query even after step 2's
   direct check succeeds, since the app's own connection pool is separate from the
   warmup script's. Also state plainly when the scheduled fault will land and how
   long it holds, so the presenter can pace their narration against it.

## If something fails

Report the real error from whichever step failed — don't retry silently more than
once, and don't claim readiness if any step didn't actually succeed. A failed warmup
or a server that never returns healthy means the demo isn't ready yet; say so plainly.

## Related

- `demo-stop` — the matching teardown skill. It also cancels any fault injection
  step 6 scheduled but hasn't fired yet, and kills it if it has — don't leave a
  scheduled or running blocking scenario behind after the demo ends.
- `mcp-server/src/warmup.ts` — the actual warmup script this drives.
- `mcp-server/src/seedBlockingScenario.ts` — the real blocking-scenario script step 6
  schedules. Can still be run by hand instead, with different timing, if the
  presenter wants to trigger it live on camera rather than have it appear on its own.
- `mcp-server/src/auth/` — session auth. `demo-stop` re-logs in rather than assuming
  step 4's cookie jar is still valid (a demo can run past the 60-minute session TTL).
