# Demo runbook: CoreOps incident-and-restart workflow

Written against the real, already-verified production setup (`coreops.fly.dev`,
plus the `dev-postgres`/`dev-superset` Fly sidecar apps, `DEMO_TARGET=prod`).
This runbook describes a procedure already proven live this session; writing it
did not require making any new production change.

## Starting state

- `coreops` healthy: `curl -sf https://coreops.fly.dev/health/dependencies` shows
  `"status":"ok"`, `"sqlServer":{"source":"live"}`.
- `dev-superset` running: `fly machines list -a dev-superset` shows state `started`.
- You are logged into the CoreOps dashboard already (session + TOTP done before
  the recording starts, never on camera).
- A second browser tab open to `fly.io/apps/dev-superset/monitoring`, so the
  real machine-state change is visible without a terminal on screen.

## Safe sample data

None required for this specific demo (the stop/restart scenario, not the
blocking-query scenario). `dev-superset` has no persistent volume, so there is
no real data at risk; stopping and restarting it is the intended, designed-for
operation (ADR-012).

## Exact actions

1. **Before recording starts** (off-camera, in a terminal you never show):
   ```
   fly machine stop <dev-superset-machine-id> -a dev-superset
   ```
   Wait ~40-60s. Confirm the incident has appeared on the CoreOps dashboard
   before you start recording.

2. **On camera:** click **Troubleshoot** on the Superset/Docker incident card.
   **Expected observable outcome:** a real, evidence-cited response referencing
   the actual connectivity failure, not a canned message.

3. **On camera:** click **Fix**, then **Approve**.
   **Expected observable outcome:** the Fly monitoring tab (second browser tab)
   shows the machine transition from `stopped` to `started` within a few
   seconds of the click. The dashboard's incident card clears once CoreOps
   independently confirms the health check passes (`confirmedHealthy: true`
   per ADR-012, not merely "restart command sent").

## What to say before and after each action

- **Before Troubleshoot:** "This incident is real, it's not seeded or staged
  content, Superset is actually down on Fly right now."
- **After Troubleshoot, before Approve:** "Nothing has executed yet. This is a
  proposal. It only becomes an action if I click Approve."
- **After Approve:** "Watch the other tab, that's Fly's own view of the
  machine, not CoreOps describing itself."

## Recovery path

If **Approve** does not visibly restart the machine within ~30 seconds:

1. Check `fly logs -a coreops` for `DOCKER_RESTART_FAILED`, if present, the
   real restart attempt failed and was reported honestly (per ADR-012, never
   silently disguised as success). Say so on camera rather than retrying
   silently.
2. Manual fallback, off-camera: `fly machine start <id> -a dev-superset`,
   then narrate that the automatic path didn't complete and this is the
   documented manual recovery, same as `docs/DEPLOYMENT.md`'s own rollback
   section models for the deploy pipeline.

## Backup plan

If the live action fails entirely or the network/Wi-Fi in the room is
unreliable: fall back to Slide 4 (Evidence) alone, and narrate from the real,
already-captured log lines in `presentation.html` (`22:12:45.300Z` detection,
`22:13:29.604Z` recovery) as a previously-run, real test, rather than
attempting a second live trigger mid-recording. State plainly that this run
is pre-recorded evidence, not happening live, if asked.

## Explicitly not covered by this runbook

The Postgres blocking-query scenario (`seedPostgresBlockingScenario.ts`)
requires a terminal session attached to `coreops` for the duration of the
hold, which conflicts with this session's "no commands during the demo"
constraint. Use the Superset stop/restart scenario above for a presentation
recording; keep the blocking-query scenario for a live, interactive Q&A
walkthrough where a terminal on screen is acceptable.
