# INCIDENT-003: Invalid Anthropic API key in production, masked by a health check that only checks presence

**Status:** Resolved — fixed against the real production instance, not simulated.
**Owner:** Quincy Nkwain Ninying
**Date:** 2026-10-01
**Component:** `mcp-server/src/healthCheck.ts` (the `anthropic.configured` check), Fly secrets

---

## What this is

A real, unplanned production incident, found while looking at the live
dashboard rather than during a drill. Worth recording for the same reason as
INCIDENT-002: the actual finding is a gap in observability, not just a fixed
credential.

## Starting symptom

The dashboard's "Troubleshoot" action, on both an SSIS and an SSRS card,
returned:

```
RECOMMENDATION_FAILED: Upstream call failed after 3 attempt(s): 401
{"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}
```

This is Anthropic's own API rejecting the key — a genuine 401 from their
servers, not a timeout, not a local bug in the retry/circuit-breaker logic
around the call.

## The gap this exposed

`GET /health/dependencies` reported `"anthropic": {"configured": true}` the
entire time the key was invalid. That field only checks that
`ANTHROPIC_API_KEY` is a non-empty string in the environment — it has never
made a real call to Anthropic to confirm the key actually works. So the one
endpoint built to surface this class of problem showed green while every
real LLM call behind it was failing. This is the same shape of gap as
INCIDENT-002's missing SQL Server secrets: a check that proves a variable
is *set*, read by a human as proof it is *correct*.

## Fix

1. Generated a new key in the Anthropic Console, named `coreops-production`
   (not reused from the old session — the invalid key is being treated as
   compromised/dead regardless of cause).
2. Deployed it: `fly secrets set ANTHROPIC_API_KEY=... -a coreops`, which
   triggered an automatic rolling redeploy of the one running machine.
3. Verified with the real path, not the health check: clicked **Troubleshoot**
   against the live dashboard after the redeploy. It returned an actual
   recommendation instead of `RECOMMENDATION_FAILED` — confirmed by the user
   directly against production, not inferred from `"configured": true`,
   which would have shown the same value before and after the fix either way.

## What this did NOT determine

Why the key went invalid in the first place (expired, revoked, or never
valid past some point) was not investigated — Anthropic's console does not
expose that history to this account in a way that was checked here. Treated
as not worth root-causing further since rotation is the correct response
either way.

## Recommendation (not built in this entry)

`healthCheck.ts`'s `anthropic.configured` check could be strengthened to
make one cheap, low-cost real call to Anthropic (or reuse the result/failure
of the most recent real recommendation call) and report `"reachable"` or
similar, separately from `"configured"`. Named here honestly as the next
real hardening step, same as INCIDENT-DRILL-001's paging gap was named
before being built the same day — not treated as already solved because a
manual key swap worked once.
