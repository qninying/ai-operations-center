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

4. **Start continuous monitoring**, so it's already running before the presenter
   triggers anything:
   ```
   curl -s -X POST http://localhost:8787/api/monitoring/start
   ```
   Confirm the response shows `"running": true` and a real `taskId`.

5. **Report readiness, don't open a browser tab yourself.** Tell the user the
   dashboard is ready at `http://localhost:8787/` and that they should open it in
   their own browser (the one they'll actually be screen-sharing) — the Claude Code
   Browser pane isn't what an audience sees. Mention that SQL Server may still take
   a little longer to fully warm on its very first real query even after step 2's
   direct check succeeds, since the app's own connection pool is separate from the
   warmup script's.

## If something fails

Report the real error from whichever step failed — don't retry silently more than
once, and don't claim readiness if any step didn't actually succeed. A failed warmup
or a server that never returns healthy means the demo isn't ready yet; say so plainly.

## Related

- `demo-stop` — the matching teardown skill, for after the demo.
- `mcp-server/src/warmup.ts` — the actual warmup script this drives.
- `mcp-server/src/seedBlockingScenario.ts` — run this separately, live, during the
  actual demo to trigger the blocking scenario. Not part of this skill — the
  presenter triggers it on camera, that's the point.
