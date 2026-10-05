# STORY-015: Make SSRS data live in production

As an operator reading CoreOps in production, I want SSRS report-run incidents
to come from the real ExecutionLog3 table, not tagged fallback data, so that
every SQL Server-family source the system claims is live in the deployed system.

**Status:** Done (2026-10-05)
**Release:** r6 · Close the remaining requirement gaps (self-scoped, added
2026-10-05; found by the trust re-score on 2026-10-03 and visible on the
Command Center as amber "serving fallback data")
**Owner:** Quincy Nkwain Ninying
**Blocked by:** nothing. The code path is built and tested, and only
production configuration is missing.

## The requirement this satisfies

- **REQ-007** (Constraint, must): The system must support integration with SQL
  Server, SSIS, SSRS, and Windows servers.

## Why this is a real gap today

`ssrsLiveSource.ts` reads `dbo.ExecutionLog3` through the same Azure SQL
connection that already runs live in production. But the `coreops` Fly app has
no `SSRS_REPORTSERVER_DATABASE` secret (`fly secrets list` shows only
`SQLSERVER_*` and `AZURE_STORAGE_*`), so SSRS falls back to fixture data. It's
correctly tagged `sourceMode: "fallback"`, and fallback evidence is excluded
from AI recommendations, but it isn't live.

## How to build it

1. Confirm the `dbo.ExecutionLog3` table exists in the production Azure SQL
   database. If it doesn't, run `seedSsrsExecutionLog.ts` against it once. It is
   idempotent (delete, then insert the same rows).
2. Set the secret: `fly secrets set SSRS_REPORTSERVER_DATABASE=<database> -a coreops`.
   This triggers a rolling redeploy.
3. Verify from outside: production logs show
   `"source":"ssrs","sourceMode":"live"`, `/health/dependencies` reports
   `sources.ssrs.sourceMode: "live"`, and the Command Center's SSRS card turns green.
4. Re-score the trust scorecard's Provenance dimension, the last one below the
   top band, and update every document that cites the score.

## Failure paths you must handle

- The table is missing in production: SSRS stays on tagged fallback (current
  behavior), the logs show the real error, and you seed it and re-check.
- Wrong database name in the secret: same honest fallback, never a crash.
  Correct the secret and re-verify.
- The redeploy fails its health check: the pipeline's automated rollback
  restores the previous release, and you confirm it the same way as in
  INCIDENT-DRILL-001.

## Acceptance: your stop condition

- [x] Production logs show `"source":"ssrs","outcome":"success","sourceMode":"live"`
      on consecutive polls. Verified 2026-10-05: before the change, a check from
      inside the `coreops` machine confirmed `dbo.ExecutionLog3` exists in
      `coreops-demo` (2 rows) and `SSRS_REPORTSERVER_DATABASE` was unset. After
      `fly secrets set SSRS_REPORTSERVER_DATABASE=coreops-demo -a coreops`,
      `fly logs` showed the old process's last polls as `fallback` (20:34:46 to
      20:34:55Z), then seven consecutive `live` polls from 20:35:03Z on.
- [x] `/health/dependencies` reports `sources.ssrs.sourceMode` as `live`, and the
      Command Center's SSRS card is green. Verified 2026-10-05: `curl
      https://coreops.fly.dev/health/dependencies` returned `sources.ssrs`
      `{"outcome":"success","sourceMode":"live"}` (uptime 19s, confirming the new
      process). The live Systems tab check is recorded in the session summary.
- [x] No secret value appears in a commit, a log line or this repo. The only
      value set is the database name, which is not a credential. Host, user and
      password are reused from the existing `SQLSERVER_*` secrets, and the
      production check printed only the table check, the row count and whether
      the setting existed.
- [x] The trust scorecard is re-scored and every document citing it is updated.
      Done 2026-10-05: Provenance moved from band 3 to band 4 (both named gaps
      closed: SSRS live, and its mode visible on the public health endpoint), for
      a 4.0/4 aggregate, self-assessed. Updated `project-blueprint/slides.html`,
      the talking points, resume bullets, panel defense prep, expo script, and
      the final showcase deck, notes and checklist. Each says "self-assessed"
      and that the rubric only scores gaps that could be named.
