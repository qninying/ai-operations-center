# ADR-007: A Real Second Approver Identity, Closing the Single-Operator Credential Model

**Status:** Implemented — built, unit-tested, and live-verified through a genuine 15-minute escalation, with durable audit-trail evidence.
**Owner:** Quincy Nkwain Ninying
**Date:** 2026-08-24
**Component:** `mcp-server/src/auth/userDirectory.ts`, `mcp-server/src/httpServer.ts`, `guardrails/hitlQueue.ts`

---

## Context

The trust scorecard's Accountability dimension named one gap: a single-operator
credential model — one `AUTH_USERNAME`, so "the approver" and "the only person who
can log in" were the same person. This wasn't just an abstract "would be nice to
have more users" wish. `guardrails/hitlQueue.ts` already had a real, working
escalation mechanism — if the primary approver doesn't decide within the decision
window, the item auto-escalates and `activeApprover` switches to `backupApprover`
(`checkForTimeout()`, and `decide()`'s `activeApprover` check). But
`httpServer.ts`'s `GUARDRAIL_BACKUP_APPROVER` was the hardcoded string
`"sre-oncall"` — no real login existed behind it. The escalation path was fully
unit-tested with mocked `decidedBy` strings, but had never been exercised by an
actual second authenticated human.

**A second, independent gap found during planning, not assumed away:**
`checkForTimeout()` was fully built and tested but **never called anywhere in
production code** — not in `POST /api/guardrail/decide`, not anywhere in
`httpServer.ts`. Its own doc comment said exactly what was missing: "a real
deployment would run this on a scheduler; tests call it explicitly." Without
fixing this, the backup approver could have had perfect credentials and still
never legitimately reached `activeApprover` — escalation was unreachable via the
live HTTP API entirely, independent of the credentials work.

## Decision drivers

| Driver | Source | Why it matters here |
|---|---|---|
| Close a named, previously-honest gap | The trust scorecard's own Accountability finding | The gap was already documented as accepted debt — closing it directly answers that finding. |
| Prove the mechanism, not just the credentials | The escalation logic already existed and was tested | Adding a second login without fixing `checkForTimeout()` would have looked complete while still being fully non-functional in production. |
| Match this system's actual shape | The escalation model names exactly two roles today | A general N-user credential store would be speculative generality this repo's conventions caution against — nothing calls for a third role yet. |
| Zero new dependencies | This repo's "new dependencies require a deliberate add" rule | The same env-var pattern already used for the primary user extends cleanly to a second one. |

## Options considered

| | **Mirror the single-user env-var pattern for exactly 2 users (chosen)** | **A general N-user credential file** |
|---|---|---|
| Matches actual current need | Yes — exactly two named roles exist today (primary, backup) | No — the escalation model has no third role to justify it |
| New dependency | None | Possibly none, but a new file format/parsing concept regardless |
| Consistency with existing code | High — reuses `hashPassword.ts`, `generateTotpSecret.ts`, the same `.env` convention unchanged | New pattern alongside the existing one |
| Cost if a third user is ever needed | Real — this specific approach doesn't scale past 2 without rework | Scales for free once built |

Confirmed directly with the user: mirror the existing pattern for exactly a
second identity, not a general store — the escalation model's actual shape
doesn't call for more than two roles right now, and inventing generality for a
role that doesn't exist yet is exactly the kind of premature abstraction this
repo's own conventions warn against.

**Two further decisions confirmed directly, not assumed:**
- **No `BACKUP_APPROVER_PASSWORD` (plaintext).** `AUTH_PASSWORD` exists solely so
  `demo-start`/`demo-stop` can `curl` a non-interactive login. This identity
  exists specifically for a real second human to log in themselves for live
  verification — not automation — so a second plaintext password would have had
  no consumer.
- **Live verification waited the real 15-minute decision window**, rather than
  adding an env-configurable window to speed up testing. `new
  HitlQueue(auditLog)` uses no options in production, so
  `DEFAULT_DECISION_WINDOW_MS` (15 real minutes, real wall clock) is what's
  actually running. Making the window configurable is real, separate scope that
  wasn't worth adding just to save 15 minutes during a one-time verification
  pass.

## Decision

**`mcp-server/src/auth/userDirectory.ts`** — a new, pure, tested module
(`DirectoryUser`, `findAuthenticatedUser()`) extracted specifically so the
credential-matching logic — previously inlined directly in `httpServer.ts`'s
`POST /api/login` handler with no dedicated test coverage — could get real unit
tests, following this repo's established "thin route, tested logic elsewhere"
pattern. Each configured user gets their own `TotpVerifier` instance (replay
protection state is private per instance; sharing one across two secrets would
corrupt it for both users). The matching loop preserves the exact short-circuit
property the single-user check already had — a wrong password for a given user
never reaches that user's TOTP verification, so it can't burn or replay-block a
currently-valid code — now transparently across 1 or 2 possible users, with the
same single generic `401 INVALID_CREDENTIALS` regardless of which user (if
either) partially matched.

**New optional env vars** `BACKUP_APPROVER_USERNAME`/`_PASSWORD_HASH`/`_TOTP_SECRET`
— deliberately **not** fail-fast, unlike `AUTH_*`. Leaving them unset keeps this
a single-operator deployment exactly as it worked before this ADR;
`GUARDRAIL_BACKUP_APPROVER` falls back to the same `"sre-oncall"` placeholder,
unchanged — a deliberate fallback now, not the only option.

**The required prerequisite fix:** one line, `hitlQueue.checkForTimeout(itemId)`,
added to `POST /api/guardrail/decide` right before `hitlQueue.decide(...)` runs.
Without this, nothing in the rest of this ADR would have been provable — the
backup approver's credentials would have been real, but escalation itself would
have stayed permanently unreachable from a live request.

## Consequences

**What this requires, already built and verified:**
- One-time setup: `npm run hash-password -- '<password>'` and
  `npm run generate-totp-secret -- <username>` (the latter gained an optional
  account-name argument specifically so a second authenticator-app entry shows
  the right label instead of the primary's username).
- 9 new unit tests in `userDirectory.test.ts`, including a cross-contamination
  case (a code valid for one user's verifier must not authenticate the other
  user) — the concrete, checkable version of "replay-protection state must not
  cross users." `mcp-server` 214/214 (up from 205), `tsc --noEmit` clean.
- **Live-verified with a genuine 15-minute real-time wait**, not simulated:
  proposed a remediation as the primary, waited the real decision window without
  deciding, logged in as the real backup approver (`sre-oncall`, its own
  password, its own TOTP secret, its own authenticator entry), and successfully
  decided the item — which only worked because of the `checkForTimeout()` fix.
  Confirmed the primary could no longer decide the same item afterward
  (`403 UNAUTHORIZED_DECIDER`, with the response explicitly naming the real
  switch: `"quincy" is not the assigned approver for this item ("sre-oncall" is)`).
  Confirmed the full, durable, four-event sequence in
  `mcp-server/data/audit-log.jsonl` (ADR-005's persisted audit trail):
  `hitl_enqueued` → `hitl_escalated` → `hitl_decision` (actor: `sre-oncall`) →
  `hitl_decision_rejected` (actor: `quincy`, `rejected_not_assigned_approver`) —
  real timestamps, real identities, not mocked strings.

**What this explicitly does not cover (flagged, not silently skipped):**
- A general N-user credential store (confirmed out of scope with the user).
- An env-configurable decision window (confirmed out of scope; real separate
  scope if ever needed for faster testing).
- Role-based access beyond the two roles the escalation model already has —
  this doesn't add a general permissions system.
- MFA for the backup approver reuses the same TOTP mechanism as the primary
  (ADR-006) — no new second-factor design was needed.

## What would change this decision

- **A genuine third named role** (not just "more users," but the escalation or
  approval model itself growing a third distinct responsibility) would be the
  real trigger to revisit the general-N-user-store option rejected above —
  mirroring the env-var pattern a third time would start to be the premature
  abstraction this ADR avoided building prematurely, in the other direction.
- **Non-interactive automation needing the backup identity** (not just a human
  logging in for verification) would be the real trigger to add
  `BACKUP_APPROVER_PASSWORD` — no consumer exists for it today.
- **A demo or test environment needing to exercise escalation repeatedly and
  quickly** would be the real trigger for an env-configurable decision window —
  a one-time 15-minute wait for this ADR's own verification wasn't reason
  enough on its own.
