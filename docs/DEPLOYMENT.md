# Deployment & Rollback Runbook

STORY-012 (REQ-025/REQ-026). Written so a different engineer, with no prior
context on this repo, can deploy a new version and execute a rollback without
asking anyone a question. If a step below doesn't work as written, that's a
defect in this document: fix it here, the same way a wrong requirement gets
fixed in `docs/REQUIREMENTS.md`.

**Host:** Fly.io (`fly.toml` at the repo root). **Registry:** GitHub Container
Registry (`ghcr.io`), image tagged with the deploying commit's short git SHA.
**Pipeline:** `.github/workflows/deploy.yml`.

## One-time setup (do this once, before the first real deploy)

1. Install `flyctl` and sign in:
   ```
   brew install flyctl        # or see fly.io/docs/hands-on/install-flyctl
   fly auth login
   ```
2. Create the Fly app (does not deploy yet):
   ```
   fly launch --no-deploy --copy-config --name <your-app-name>
   ```
   This fills in `app = "<your-app-name>"` at the top of `fly.toml`; commit
   that change. Do not let `fly launch` overwrite the rest of `fly.toml`; if it
   offers to, decline and keep this repo's version.
3. Create the persistent volume for the audit trail (ADR-005). The deploy
   fails fast if this doesn't exist yet, which is deliberate:
   ```
   fly volumes create coreops_data --region iad --size 1
   ```
4. Set every secret `mcp-server/.env.example` documents as required
   (`AUTH_USERNAME`, `AUTH_PASSWORD_HASH`, `MFA_TOTP_SECRET`,
   `ANTHROPIC_API_KEY`, and any optional ones you want live, such as
   `NTFY_TOPIC` and `MCP_API_TOKEN`). One call per secret, or all at once:
   ```
   fly secrets set AUTH_USERNAME=... AUTH_PASSWORD_HASH=... MFA_TOTP_SECRET=... ANTHROPIC_API_KEY=...
   ```
   Never put a real value in `fly.toml` or a GitHub Actions file; both are
   committed source.
5. Generate a Fly deploy token and add it to this GitHub repo's
   **Settings → Secrets and variables → Actions** as `FLY_API_TOKEN`:
   ```
   fly tokens create deploy
   ```
6. After the first successful image push, GitHub defaults the new
   `ghcr.io/<owner>/ai-operations-center` package to **private**. Fly needs to
   pull it: either make the package **public** (Package settings →
   Change visibility), simplest for a single-operator deploy like this one, or
   configure a registry pull secret on Fly if it must stay private.

## Normal deploy

Push to `main`. `.github/workflows/deploy.yml` runs the full test suite
(`mcp-server`, `guardrails`, `frontend`) as a gate, builds the image, tags it
`ghcr.io/<owner>/ai-operations-center:<short-sha>`, and deploys it to Fly with
`--strategy rolling`. The new machine must pass `fly.toml`'s `GET /health`
check before the release completes; a machine that never goes healthy fails
the deploy, leaving the last successful image as the running release.
**Not bluegreen:** this app mounts a Fly volume for the ADR-005 audit trail,
and Fly volumes can only be claimed by one machine at a time — bluegreen (and
canary) need two machines running concurrently, so both fail outright against
a volume-mounted app (`failed_precondition: volume already claimed`, every
time, confirmed live). With `min_machines_running = 1`, rolling means the old
machine is torn down before the new one is confirmed healthy, so there is a
real, brief window of unavailability on every deploy that bluegreen's
overlap would have avoided.

To watch a deploy: `fly logs`. To confirm it's live:
```
curl -sf https://<your-app-name>.fly.dev/health
```
run from your own machine, not from the host. A health check the app reports
about itself proves nothing about whether it's reachable from the outside.

## Rollback

Two ways, both landing on the exact same `flyctl deploy --image ...` code path
the normal deploy job uses. There is no separate, rarely-exercised "rollback
mode" to distrust during a real incident.

**From GitHub Actions (recommended: keeps the pipeline as the one path that
touches production):** Actions → "Deploy to production" → **Run workflow**,
fill in `image_tag` with the short SHA of the last known-good build (find it in
a previous successful run's logs, or `git log --oneline`), leave the branch as
`main`. This redeploys that exact image with no rebuild.

**Directly, if GitHub Actions itself is unavailable:**
```
fly deploy --image ghcr.io/<owner>/ai-operations-center:<known-good-sha> --strategy rolling
```

Either way, confirm recovery the same way as a normal deploy: `curl` `/health`
from your own machine, then `GET /health/dependencies` to see the honest
live/fallback state of SQL Server and whether Anthropic is configured.

## Health checks

- `GET /health`: liveness only, no dependency calls. This is what `fly.toml`'s
  `[[http_service.checks]]` polls, and what gates whether a rolling deploy's
  new machine is accepted as the release.
- `GET /health/dependencies`: readiness. Reports SQL Server as `live` or
  `fallback` (this app's existing tagging convention; fallback is an honest
  degraded-but-serving state, not a failure) and whether `ANTHROPIC_API_KEY`
  is configured. Cached 15s server-side (`mcp-server/src/healthCheck.ts`) so
  polling it doesn't turn into a load test of SQL Server.

## Incident / rollback drill

See `docs/INCIDENT-DRILL-001.md` for the real, timed drill this story requires
before it can be marked done: a deliberately broken build deployed, caught,
and rolled back against the actual live instance, not simulated.

## Who to page

Single-operator deployment, same model as the rest of this repo's
authentication story (`docs/ADR-007-second-approver-identity.md`): the app
owner is the only on-call. There is no second responder configured for this
production instance yet, a real gap for anything beyond a portfolio deploy,
named here honestly rather than implied away.
