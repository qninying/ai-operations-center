# INCIDENT-002: Production SQL Server connectivity — four independent layers, found and fixed live

**Status:** Resolved — fixed against the real production instance, not simulated.
**Owner:** Quincy Nkwain Ninying
**Date:** 2026-10-01
**Component:** Azure subscription/firewall, Fly.io networking, `mcp-server/src/httpServer.ts`, Fly secrets, `frontend/package-lock.json`
**Related:** `docs/DEPLOYMENT.md` (updated as a direct result of this incident)

---

## What this is

Unlike `INCIDENT-DRILL-001.md`, this was not a deliberate drill — it started as
an ordinary question ("why can't production reach SQL Server?") and turned
into a real, unplanned, multi-layer debugging session. Worth recording for
the same reason DRILL-001 was: the value is in the evidence trail, not the
conclusion. Four independent problems compounded, each one masking the
next, and each was isolated with a specific test before being called "the
cause" — not assumed from the first plausible-looking symptom.

## Starting symptom

`GET https://coreops.fly.dev/health/dependencies` reported
`"sqlServer": {"source": "fallback"}` in production, while a similar check
had at some point appeared to work locally. The instinct was "firewall
issue." It was not — or rather, it was one of four unrelated issues, and the
firewall was the easiest of the four to fix once reached.

## The four layers, in the order they were actually found

### 1. Azure Blob secrets were never set on Fly at all
`fly secrets list -a coreops` never had `AZURE_STORAGE_*`. Unrelated to SQL
Server, but the first gap found, and fixed first: `fly secrets set
AZURE_STORAGE_CONNECTION_STRING=... AZURE_STORAGE_CONTAINER=...`.

### 2. The Azure subscription hosting `quinaidemo` was disabled
Adding the Azure SQL firewall rule failed with:
```
Failed to update server firewall rules for server quinaidemo. Error: The
subscription 'c381d2ff-0296-4ee4-9e54-12a50b08e62f' is disabled and
therefore marked as read only.
```
This was not a permissions error — the whole subscription was read-only.
Root cause: an Azure free-trial-to-Pay-As-You-Go conversion had happened
at some point, and `az account show` still pointed at a stale CLI session.
After `az login` and re-checking, the *same* subscription ID now showed
`state: Enabled` — the conversion had in fact re-enabled the original
subscription in place (Azure's official upgrade path keeps the same
subscription ID), not created a separate new one as first assumed.
`az sql server list` then confirmed the original `quinaidemo` server and its
`CoreOps-Demo` resource group were still intact — no data loss, no new
server needed, just a retry of the firewall rule against the now-enabled
subscription, which succeeded immediately.

### 3. Fly's default egress IPs aren't stable enough to allowlist
Azure SQL's firewall needs a fixed IP to allow. Fly machines don't have one
by default. Fixed with a static egress IP:
```
fly ips allocate-egress --app coreops -r iad   # $3.60/mo
```
Applied automatically to the running machine; no redeploy needed. The
resulting IP (`209.71.111.44`) is what the firewall rule in step 2 actually
allowed.

### 4. Node resolving the hostname via a dead IPv6 route — the real final blocker
After steps 1–3, `/health/dependencies` *still* reported `fallback`. The
decisive piece of evidence: `nc -zv -w 10 quinaidemo.database.windows.net
1433` succeeded instantly from the same machine where the app's own
connection test hung for over a minute — past the app's own configured
10-second `connectionTimeout`. A tool that defaults to IPv4 working while
the app hangs is the signature of a DNS-resolution-order problem, not a
network/firewall one: Node tries the AAAA (IPv6) record first, and the
`getaddrinfo` hang happens *before* `tedious`'s own timeout timer starts, so
the app's configured timeout never gets a chance to fire. Confirmed by
re-running the identical test with `node --dns-result-order=ipv4first`,
which returned `SUCCESS` immediately. Fixed process-wide in
`mcp-server/src/httpServer.ts` (commit `6473530`) with
`dns.setDefaultResultOrder("ipv4first")` at the entry point, rather than a
per-connection flag — this covers every outbound call in the process (SQL
Server, SSRS, Azure Blob, Anthropic API, ntfy), not just the DMV path.

### The one after all four: the actual credentials were never deployed
Even after fixing all four layers above, production still showed `fallback`
on the first post-deploy check. `fly secrets list -a coreops` showed
`SQLSERVER_HOST`/`SQLSERVER_DATABASE`/`SQLSERVER_USER`/`SQLSERVER_PASSWORD`
had simply never been set — `docs/DEPLOYMENT.md` never documented this step
(now fixed, see below), and nobody had run it. Set directly from local
`.env`, which immediately resolved to `"source": "live"`.

## A separate, unrelated bug found along the way

While re-running the full three-suite test gate before pushing, the
`frontend` suite failed with a 60-second "Timeout waiting for worker to
respond" on every file, including a trivial test with no React/jsdom
involved. Ruled out, in order, with a real test for each: Node version
(22 vs. 25 — identical failure on both), vitest version (pinned to `4.1.10`
to match `mcp-server`/`guardrails`, still failed; then tested the original
`^4.1.11` after a clean install, which worked perfectly). The actual cause
was a corrupted/stale `node_modules` tree, unrelated to any version number.
Fixed with `rm -rf node_modules package-lock.json && npm install` (commit
`2077b79`).

## Evidence timeline (UTC, from real command output, 2026-10-01)

| Time | Event |
|---|---|
| 17:10:09 | Azure Blob secrets set; `/health/dependencies` still `sqlServer.source: fallback` (expected — SQL Server not yet addressed). |
| ~17:2x | Azure Portal firewall save fails: subscription disabled. |
| 17:26:58 | `az account show` confirms the subscription is `Enabled` again (post re-login); `az sql server list` confirms `quinaidemo` intact. Firewall rule applied successfully. |
| 17:35:26 | Static egress IP allocated and firewall rule in place; `/health/dependencies` still `fallback`. |
| — | Local `nc` test succeeds; local app-level test hangs >60s. IPv6 resolution-order theory formed and confirmed with `--dns-result-order=ipv4first`. |
| — | `httpServer.ts` fix written, type-checked, and verified against all three test suites (387 + 70 + 6 passing). |
| — | Commits `6473530` (DNS fix) and `2077b79` (frontend lockfile fix) pushed; GitHub Actions run `36906228496` passes test → build → deploy end to end. |
| 18:24:40 | Post-deploy check: still `fallback` — `SQLSERVER_*` secrets found never set. |
| 18:27:01 | `SQLSERVER_*` secrets set from local `.env`; `/health/dependencies` → `"source": "live"`. |
| 18:28:32 | Stability re-check, 122s uptime: still `"live"`. |

## What this incident actually proved

1. **A symptom that looks like one thing (firewall) can be four unrelated
   things stacked**, and the honest fallback behavior this app was built
   with (serve fixture data, say so, never fabricate) made all four
   invisible as anything other than "fallback" — no error ever surfaced
   past `dmvReader.ts`'s own catch block, because it didn't log the real
   cause (see the follow-up fix below).
2. **Raw reachability tools (`nc`) and the app's own driver (`mssql`/
   `tedious`) can disagree about whether a host is "reachable"** — a gap
   worth remembering any time a connectivity bug resists an otherwise-clean
   network diagnosis.
3. **"It would also work locally" is not something to assume** — the same
   worker-pool failure that first looked like a tool-sandbox artifact turned
   out to reproduce identically on the real development machine, and the
   same `node_modules` corruption pattern could just as easily hit a CI
   runner or a teammate's machine.

## Follow-up fixes shipped as a direct result

- `dmvReader.ts` now logs the real underlying error (`dmv_live_source_failed`,
  with error class, message, and cause) before falling back, instead of
  silently swallowing it — this incident required a from-scratch local
  reproduction specifically because `fly logs` had nothing useful to show.
- `docs/DEPLOYMENT.md` now documents the `SQLSERVER_*` and `AZURE_STORAGE_*`
  secrets, the static egress IP + firewall rule steps, and the IPv6
  resolution-order gotcha, so the next person following that runbook doesn't
  rediscover any of this by hand.
- `mcp-server`, `guardrails`, and `frontend`'s `package.json` now all declare
  `"engines": {"node": "22.x"}`, matching the Dockerfile's `node:22-alpine`
  — closing the dev/prod Node version drift (25 vs. 22) that made some of
  this harder to reason about, even though it was not the actual root cause
  of either bug found here.
