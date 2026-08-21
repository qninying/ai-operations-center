---
name: demo-stop
description: Stop the CoreOps mcp-server HTTP server and any monitoring it started for a demo, cleanly and idempotently. Use when the user says "stop the demo", "shut everything down", "kill the demo server", or is wrapping up after a CoreOps demo or rehearsal.
---

# CoreOps Demo Stop

Cleanly stops everything `demo-start` started. Safe to run even if nothing is
running — every step here is idempotent, matching this repo's own idempotency rule.

## Steps

1. **Cancel any scheduled or running fault injection first**, before it can fire
   after the demo has already ended:
   ```
   pkill -f "coreops-fault-injector.sh" 2>/dev/null
   pkill -f "seedBlockingScenario.ts" 2>/dev/null
   ```
   Matches on the wrapper script's distinctive path, not a captured PID — `demo-start`
   deliberately doesn't rely on `$!` for this (confirmed unreliable in this
   environment: it captured the wrong process when tested directly). Both `pkill`s
   are safe to run even if nothing was scheduled — a no-op `pkill` just exits
   non-zero silently, which is the correct outcome here, not an error. This matters
   even if `demo-start`'s step 5 already fired and resolved on its own: killing an
   already-finished process's name match is harmless.

2. **Stop monitoring next, while the server can still hear the request:**
   ```
   curl -s -X POST http://localhost:8787/api/monitoring/stop
   ```
   If the server isn't running, this will just fail to connect — that's fine,
   continue to step 3 rather than treating it as an error.

3. **Stop the HTTP server process:**
   ```
   pkill -f "tsx src/httpServer.ts"
   ```

4. **Confirm it's actually down**, don't just assume the kill worked:
   ```
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/health
   ```
   A `000` confirms nothing is listening on port 8787 anymore. If it still responds,
   something else is holding the port or the process didn't die — investigate rather
   than reporting success.

5. **Report the clean state.** Confirm to the user that any pending fault injection
   was cancelled, monitoring was stopped, and the server is down — don't leave them
   wondering whether something is still running in the background after they've
   closed their laptop.

## Related

- `demo-start` — the matching setup skill.
