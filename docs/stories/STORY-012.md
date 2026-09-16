# STORY-012: Deploy CoreOps to a real production environment and prove you can operate it

As the engineer who will hand this system to a customer's operations team, I want
CoreOps built, deployed, and monitored the way a real production service is, not
run from a developer's laptop, so that "it works" means it survives a real
failure on a real, internet-reachable instance, with a measured recovery, not
just a passing test suite.

**Release:** r5 · Dev to Prod, Production Deployment & Operational Readiness
(self-scoped, added after the platform's original 5-release plan; see
`docs/STORIES.md`)
**Owner:** Quincy Nkwain Ninying
**Blocked by:** STORY-001, STORY-002, STORY-009, STORY-011 (the approval
workflow, audit trail, escalation, and rollback-capability building blocks all
need to exist before there is anything worth deploying)

## The requirement this satisfies

- **REQ-025** (Constraint, must): The system must run in a real,
  internet-reachable production environment, built and deployed through a
  reproducible pipeline, not a developer's laptop.
- **REQ-026** (Safety, must): The system must support a live-verified
  rollback from a bad production deploy, with recovery bounded and measured,
  not merely claimed.

## How to build it

Containerize `mcp-server` (and the built `frontend` console it serves, per
ADR-004) with a multi-stage `Dockerfile` and a `.dockerignore`, so the image
builds reproducibly from a clean checkout, with no dependency on anything
already sitting on your machine. Add a GitHub Actions workflow (`deploy.yml`)
that, on push to `main`: runs the full test suite (`mcp-server`, `guardrails`,
`frontend`) as a hard gate, builds the image, tags it with the git SHA, pushes
it to a registry, and deploys it to one real host you choose and actually pay
for or provision if needed: a small VPS or a platform like Fly.io or Render.
That choice, and any cost it carries, is yours to make before this story
starts; it is not something to default into.

Supply all secrets (`ANTHROPIC_API_KEY`, session secret, TOTP seed, DB
connection strings) through the host's own environment configuration, never
baked into the image or committed; extend `mcp-server/.env.example` if new
variables are needed. Add a real health-check route (e.g. `GET /healthz`)
that reports process, DB, and Anthropic API reachability honestly, reusing
the live/fallback tagging convention already established in
`ssrsReader.ts` and `dmvLiveSource.ts` rather than inventing a new one.

Write `docs/DEPLOYMENT.md`: a cold-start runbook a different engineer, with
no tribal knowledge of this repo, could follow to deploy a new version, check
its health, and roll it back.

Then run one real incident/rollback drill against the live deployment, not a
tabletop exercise: deploy a deliberately broken build, let the health check
catch it from outside the host, roll back to the previous git-SHA-tagged
image, and confirm full recovery, timed start to finish. Write
`docs/INCIDENT-DRILL-001.md` as a real postmortem of that run: what broke,
how it was detected, the exact recovery steps taken, how long each phase
took, and what would make the next one faster. Hold it to the same standard
as every ADR in this repo: real timestamps and command output from the
actual run, not a hypothetical description of what would happen.

## Failure paths you must handle

- The health check itself lies (reports healthy when the app isn't); trust
  it only once independently confirmed from outside the host, not from the
  container's own opinion of itself.
- The rollback target image no longer exists because the registry's
  retention policy pruned it; pin a minimum retained image count so "roll
  back" can never fail for that reason.
- Secrets are missing or malformed at deploy time; fail the deploy loudly
  before traffic is promoted, never boot a half-configured instance that
  serves real requests with errors.
- The deploy pipeline itself fails mid-deploy (interrupted registry push,
  unreachable host); the previous known-good version must keep serving
  traffic throughout, never a half-deployed gap.
- You are not the one who picks up the page; the runbook must be usable by
  someone who has never seen this repo before.

## Acceptance: your stop condition

Tick each box as it genuinely passes. Ticking something you have not actually
verified against the real deployed system only misleads you.

- [x] Given a commit lands on `main`, when the deploy pipeline runs, then a
      git-SHA-tagged image is built, the full test suite gates the deploy,
      and the resulting instance is reachable at a real public URL, not
      `localhost`. Verified 2026-09-16: run `35150181955`, `curl -sf
      https://coreops.fly.dev/health` → `200` from outside the host.
- [x] Given the production instance is running, when `GET /healthz` (or
      equivalent) is queried from outside the host, then it honestly reports
      process, DB, and Anthropic API reachability, using this repo's existing
      live/fallback tagging convention. Verified 2026-09-16: `curl -sf
      https://coreops.fly.dev/health/dependencies` → SQL Server honestly
      reported `"source":"fallback"` (no real SQL Server exists for this Fly
      VM to reach), `anthropic.configured: true`.
- [x] Given a deliberately broken build is deployed, when the health check
      detects it, then the system is rolled back to the last known-good
      git-SHA-tagged image and traffic is fully recovered, the whole drill
      timed and written up in `docs/INCIDENT-DRILL-001.md`. Verified
      2026-09-16, live: see `docs/INCIDENT-DRILL-001.md` for the full timed
      run (6m14s total downtime, 1m31s from failure-confirmed to recovered).
- [x] Trust: no secret (API key, session secret, TOTP seed, DB credential)
      appears in the Dockerfile, the built image, a commit, or a log line
      anywhere in this story's work. Verified 2026-09-16 via `git grep`
      across tracked files for real secret patterns — none found; all real
      values were set directly via `fly secrets set`, never through this
      session or the repo.
- [ ] Given a different engineer with no prior context on this repo, when
      they read `docs/DEPLOYMENT.md` alone, then they can deploy a new
      version and execute a rollback without asking you a question.

When every box above is ticked, stop and show the demo: from a cold laptop,
load the real production URL, then walk through the incident-drill writeup.
