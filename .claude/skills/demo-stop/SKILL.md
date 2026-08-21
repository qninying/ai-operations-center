---
name: demo-stop
description: Stop the CoreOps mcp-server HTTP server and any monitoring it started for a demo, cleanly and idempotently. Use when the user says "stop the demo", "shut everything down", "kill the demo server", or is wrapping up after a CoreOps demo or rehearsal.
---

# CoreOps Demo Stop

Cleanly stops everything `demo-start` started. Safe to run even if nothing is
running — every step here is idempotent, matching this repo's own idempotency rule.

## Steps

1. **Stop monitoring first, while the server can still hear the request:**
   ```
   curl -s -X POST http://localhost:8787/api/monitoring/stop
   ```
   If the server isn't running, this will just fail to connect — that's fine,
   continue to step 2 rather than treating it as an error.

2. **Stop the HTTP server process:**
   ```
   pkill -f "tsx src/httpServer.ts"
   ```

3. **Confirm it's actually down**, don't just assume the kill worked:
   ```
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/health
   ```
   A `000` confirms nothing is listening on port 8787 anymore. If it still responds,
   something else is holding the port or the process didn't die — investigate rather
   than reporting success.

4. **Report the clean state.** Confirm to the user that monitoring was stopped and
   the server is down — don't leave them wondering whether something is still
   running in the background after they've closed their laptop.

## Related

- `demo-start` — the matching setup skill.
