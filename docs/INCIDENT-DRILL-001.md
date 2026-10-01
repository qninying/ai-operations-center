# INCIDENT-DRILL-001: Broken health check, caught and rolled back

**Status:** Complete — run live against production, not simulated.
**Owner:** Quincy Nkwain Ninying
**Date:** 2026-09-16
**Component:** `.github/workflows/deploy.yml`, `mcp-server/src/httpServer.ts`, `fly.toml`
**Satisfies:** STORY-012 / REQ-026 (a live-verified, bounded rollback)

---

## What this is

A real, timed rollback drill against `https://coreops.fly.dev`, run to close
STORY-012's last open acceptance criterion: prove the deploy pipeline catches
a bad build and recovers, with a measured time, not a claimed one. Every
timestamp and command result below is from the actual run (UTC).

## What broke, on purpose

`mcp-server/src/httpServer.ts`'s `GET /health` handler was changed to return
`500 {"status": "error"}` instead of `200 {"status": "ok"}`. This was chosen
deliberately because no test in this repo asserts on that route's status
code (confirmed by grep across `mcp-server/src/*.test.ts` before starting),
so it passes the CI test gate — the same way a real regression that only
shows up at runtime would. The only thing meant to catch it is `fly.toml`'s
`[[http_service.checks]]` against `GET /health`, exactly the boundary this
drill needs to exercise.

## Timeline (all times UTC, 2026-09-16)

| Time | Event |
|---|---|
| 22:31:56 | Broken commit (`acaeed4`) pushed to `main`. |
| 22:32:03 | Deploy pipeline run `35158141086` starts. |
| ~22:32–22:34 | `test` and `build-and-push` jobs pass (as expected — the break is invisible to the test suite by design). |
| 22:34:28 | New machine (`8de50dfe11d358`) updated to image `acaeed4d3646`, per `fly machines list`. |
| 22:35:00 | First observed failure from outside the host: `curl https://coreops.fly.dev/health` → `500`. |
| 22:35:45 | Health check degrades further: `curl` → connection failure (`000`), not just a 500 — Fly's proxy stopped routing to the unhealthy machine entirely. |
| 22:39:43 | `deploy` job in run `35158141086` completes with **failure**: `flyctl deploy --strategy rolling` gave up waiting for the new machine to pass `GET /health` and failed the release. |
| 22:40:20 | Confirmed via `fly machines list -a coreops`: one machine, `8de50dfe11d358`, running image `acaeed4d3646` (the broken build), `0/1` checks passing, state `started`. **No automatic rollback to the prior image occurred** — the broken machine was left running and unreachable. |
| 22:40:33 | Rollback triggered: `gh workflow run deploy.yml --ref main -f image_tag=3398b70f521f` (the last known-good SHA, the release live before this drill). This is the exact path `docs/DEPLOYMENT.md` documents — no separate rollback code, the same `flyctl deploy --image ... --strategy rolling` step. Run `35158821088`. |
| 22:41:14 | `curl https://coreops.fly.dev/health` → `200 {"status":"ok"}`. Run `35158821088` completes with **success** at the same timestamp. |
| 22:41:37 | The break itself reverted on `main` (`git revert acaeed4` → `b379485`) so no future push could reintroduce it. Pushed immediately after, triggering a normal (non-rollback) deploy of the fixed code, which also completed successfully. |

## Measured recovery time

- **Detection to failed-release confirmation:** 22:35:00 → 22:39:43 = **4m43s**.
  This is `flyctl`'s own wait-for-healthy timeout on the rolling strategy, not
  time this operator spent diagnosing anything — the platform was still
  deciding the release had failed.
- **Failed-release confirmation to full recovery:** 22:39:43 → 22:41:14 =
  **1m31s**. This is the number that reflects operator response: one
  `gh workflow run` command, no investigation needed, because the runbook
  (`docs/DEPLOYMENT.md`) already named the exact command and the last
  known-good tag was already known from `git log`.
- **Total user-facing downtime, first failure to recovery:** 22:35:00 →
  22:41:14 = **6m14s**.

## What this drill actually proved

1. **The health-check gate works.** A change invisible to the test suite was
   still caught before staying live, exactly as `fly.toml`'s
   `[[http_service.checks]]` is supposed to do.
2. **The documented rollback path works as written**, on the first real
   attempt, with no deviation from `docs/DEPLOYMENT.md` — a different
   engineer following that doc cold could have executed the same recovery.
3. **A genuine, previously-undocumented gap**: `docs/DEPLOYMENT.md` and
   `deploy.yml`'s comments already predicted that `rolling` (unlike the
   `bluegreen` this app can't use — see the prior PROGRESS.md entry on that
   discovery) tears the old machine down before the new one is confirmed
   healthy, calling it "a real, brief window of unavailability." This drill
   shows that window is not automatically bounded: Fly does **not**
   auto-revert to the last-good image when a rolling deploy's health check
   never passes. It leaves the broken machine running and unreachable
   indefinitely, until a human (or a second pipeline run) intervenes. "Brief"
   was accurate here only because the operator was watching and rolled back
   within about a minute and a half of the failure being confirmed. An
   unattended failure — a broken deploy pushed right before the operator
   goes offline — would stay down until someone notices, not self-heal.

## Recommendation this drill produced

The single-operator model this repo already documents honestly
(`docs/DEPLOYMENT.md`'s "Who to page" section) makes the gap above worse than
it would be with a second on-call: nothing currently pages anyone when a
deploy's health check fails. A `deploy` job step that alerts on
`flyctl deploy` exiting non-zero (the same `notifyOperators` mechanism this
repo already uses for production incidents, or a plain GitHub Actions
failure notification) would turn "the operator happened to be watching" into
"the operator gets paged," closing the actual gap this drill surfaced. Not
built as part of this drill — named here honestly as the next real
hardening step, per this repo's own Failure-First Design convention, rather
than treated as already solved because the manual rollback worked once.

## Raw evidence

```
$ curl -sf https://coreops.fly.dev/health   # before the drill
{"status":"ok"}

$ curl -s -o /dev/null -w "%{http_code}" https://coreops.fly.dev/health   # 22:35:00Z
500

$ curl -s -o /dev/null -w "%{http_code}" https://coreops.fly.dev/health   # 22:35:45Z
000   (connection failure -- Fly stopped routing to the unhealthy machine)

$ fly machines list -a coreops   # 22:40:20Z
 ID             NAME             STATE    CHECKS  IMAGE
 8de50dfe11d358 holy-shape-5040  started  0/1     qninying/ai-operations-center:acaeed4d3646

$ gh workflow run deploy.yml -R qninying/ai-operations-center --ref main -f image_tag=3398b70f521f
https://github.com/qninying/ai-operations-center/actions/runs/35158821088

$ curl -s -o /dev/null -w "%{http_code}" https://coreops.fly.dev/health   # 22:41:14Z
200
```

GitHub Actions runs: broken deploy
[`35158141086`](https://github.com/qninying/ai-operations-center/actions/runs/35158141086)
(failed, as intended), rollback
[`35158821088`](https://github.com/qninying/ai-operations-center/actions/runs/35158821088)
(succeeded), cleanup redeploy of the reverted fix (succeeded, triggered by
commit `b379485`).

## Addendum, 2026-10-01: the paging recommendation above, actually tested

The "Recommendation this drill produced" section above was first built on
2026-09-17 (commit `8c21a3d`) and reverted 14 minutes later (`ea93b60`) with
no reason recorded at the time — a real process failure in its own right,
caught and named honestly during INCIDENT-002
(`docs/INCIDENT-002-sql-server-connectivity.md`). The actual reason,
reconstructed from that commit's own notes: the step depended on an
`NTFY_TOPIC` GitHub Actions secret that was never set, so it would have
posted to nowhere — reverting an unverifiable safety net was the right call,
it just needed to be re-done properly instead of left open indefinitely.

**How this was actually verified, not assumed:**

1. Set a real `NTFY_TOPIC` GitHub Actions secret (confirmed present via
   `gh secret list`, value never exposed in any log or session).
2. Re-applied the paging step to `.github/workflows/deploy.yml` (commit
   `172e223`), validated with `ruby -ryaml -e "YAML.load_file(...)"` before
   pushing — same method that caught a real YAML bug in the original 2026-09-17
   attempt.
3. Triggered a **deliberately failing** deploy via `gh workflow run deploy.yml
   --ref main -f image_tag=deliberately-nonexistent-tag-for-paging-test` — a
   tag that cannot exist in the registry, so `flyctl deploy` fails at the
   image-fetch step, before ever touching the running machine. This is safer
   than this drill's original method (a real broken health check): it proves
   the same `if: failure()` path with zero real downtime.
4. Read the run's own logs
   ([`36910224762`](https://github.com/qninying/ai-operations-center/actions/runs/36910224762))
   directly, not assumed from the step turning green: `flyctl deploy` failed
   with `Could not find image "...deliberately-nonexistent-tag-for-paging-test"`,
   exit code 1; the paging step then ran and its `curl` returned ntfy.sh's own
   API response confirming real delivery: `{"id":"CuwMkW1WOwBF","event":"message","title":"CoreOps: deploy_failed",...}`
   — a message ID from ntfy.sh's server is independent proof of delivery, not
   just proof the `curl` command exited zero.
5. Confirmed from outside the host, before and after, that production itself
   was unaffected: `curl -sf https://coreops.fly.dev/health/dependencies`
   showed `"source": "live"` throughout, uptime climbing continuously across
   the test with no interruption.

This closes the gap the original drill found: a failed deploy now pages the
operator automatically, verified against a real failure, not inferred from
the YAML looking correct.

## Addendum, 2026-10-01 (same day): automating the one remaining manual step

The addendum above still left one human action after the page: run the
rollback command. Automated that too (commit `731dcdb`) — the `deploy` job
now captures the currently-running image *before* attempting a new one, and
on failure automatically redeploys that captured image, with the page
reporting which actually happened rather than always asking for a manual
command.

**How this was actually verified, not assumed:**

1. Recorded the running image tag before the test:
   `fly image show --json` → `731dcdbac43a`.
2. Triggered another deliberately-failing deploy — a new bad tag,
   `deliberately-bad-tag-for-autorollback-test` — via the same
   `gh workflow run` method as the first addendum.
3. Watched the job's own step list, not just its final status: `Deploy new
   image` failed, `Auto-rollback to the previous image` then ran and
   succeeded, `Page operator on deploy failure` ran last
   ([`36913419056`](https://github.com/qninying/ai-operations-center/actions/runs/36913419056)).
4. Read the raw logs to confirm the rollback was a genuine Fly deployment, not
   a no-op: `Machine 8de50dfe11d358 reached started state`, `Checking health
   of machine 8de50dfe11d358`, `✔ Machine 8de50dfe11d358 is now in a good
   state`.
5. Confirmed the page sent the correct branch of its message (success, not
   escalation) by reading the actual env values logged for that step —
   `ROLLBACK_OUTCOME: success`, `PREVIOUS_TAG: 731dcdbac43a` — and ntfy.sh's
   own delivery confirmation: `{"id":"wKo3Plda9K8E",...,"message":"...
   auto-rolled-back to the previous image (731dcdbac43a), which is now live
   again...",...}`.
6. Confirmed after the test, from outside the host: `fly image show --json`
   showed `731dcdbac43a` running again (the correct tag, not the bad one),
   and `curl -sf https://coreops.fly.dev/health/dependencies` showed
   `"source": "live"`.

This closes the second half of the original drill's recommendation: a failed
deploy now recovers itself, with no human action required to restore
service, and the human is told which outcome actually happened rather than
given a generic instruction.
