# ADR-003: Session-Based Authentication over JWT for the CoreOps API

**Status:** Implemented — built, unit-tested, and live-verified against the running server.
**Owner:** Quincy Nkwain Ninying
**Date:** 2026-08-23
**Component:** `mcp-server/src/auth/`, `mcp-server/src/httpServer.ts`, `guardrails/hitlQueue.ts`

---

## Context

A trust-boundary audit of `dashboard.html` on 2026-08-21 (see the PROGRESS.md entry
for that date) surfaced the largest real gap in the system: every route on
`httpServer.ts` was reachable by anyone who could reach the port, with no identity
check at all. This was not an abstract risk. `guardrails/hitlQueue.ts` enforces a
concrete governance rule — only the assigned approver may decide a pending
remediation — but the field it compared against, `GUARDRAIL_PRIMARY_APPROVER`, was a
hardcoded constant compared against itself. `UnauthorizedDeciderError` existed in
code but could never actually fire. The human-approval gate this whole system's
governance story depends on (per this repo's `CLAUDE.md`: "human approval for
production changes") had no real identity behind it.

Fixing that requires real authentication: a verified login, and a decider identity
on every guardrail decision and audit-trail entry that traces back to a person who
actually authenticated, not a string nobody checks.

## Decision drivers

| Driver | Source | Why it matters here |
|---|---|---|
| Instant, provable revocation | Governance requirement — an approver's access must be revocable | A session can be deleted from the store and is immediately gone. A JWT is valid until it expires unless a separate revocation list is built and checked on every request — which reintroduces the server-side state a JWT is chosen to avoid, for no benefit. |
| Single-process deployment | Actual current topology — one `mcp-server` Node process, no horizontal scaling | JWT's core advantage — no shared session state needed across replicas — has nothing to buy here. There is exactly one process holding state already (in-memory `hitlQueue`, `auditLog`). |
| XSS exposure class already found and fixed | The 2026-08-21 audit (this session) found and fixed real unescaped `innerHTML` sinks in `dashboard.html` | A JWT commonly lives in `localStorage`, directly readable by any script that runs on the page — the exact class of bug just fixed. A session token in an `HttpOnly` cookie is not readable by page JavaScript at all, verified directly (`document.cookie` returns nothing for the session cookie). |
| Single operator, one browser session at a time | Current real usage — one `AUTH_USERNAME`/`AUTH_PASSWORD_HASH` pair, not a multi-tenant API | JWT's portability across services and issuers is solving a problem — many independent API consumers — that does not exist yet in this system. |
| Same-origin frontend and backend | `dashboard.html` and (after a later change) the built `frontend/` console are both served by `mcp-server` itself | No cross-origin token-passing problem to solve. A cookie with `SameSite=Strict` does the CSRF-mitigation work directly, without a separate CSRF-token scheme JWT-over-`Authorization`-header would still need for state-changing requests. |

## Options considered

| | **Session (cookie + server-side store)** | **JWT (stateless, `Authorization` header or `localStorage`)** |
|---|---|---|
| Revocation | Immediate — delete from `SessionStore` | Not possible before expiry without a server-side blocklist (defeats statelessness) |
| Storage exposed to page JS | No — `HttpOnly` cookie is invisible to `document.cookie` and any script | Yes, if stored in `localStorage`/`sessionStorage` (the common pattern for SPA JWT auth) |
| CSRF mitigation | `SameSite=Strict` on the cookie, no extra scheme needed | Needs its own handling if ever sent automatically; less of an issue if manually attached to headers, but then storage exposure (above) is the tradeoff |
| Server state required | Yes — one `SessionStore` (in-memory today) | No, by design — the whole point of JWT |
| Fits current topology (one process, one operator) | Yes, directly | Solves a distributed/multi-consumer problem this system doesn't have yet |
| Implementation cost here | Small — `node:crypto` only, no new dependency | Small also (a JWT library), but the *statelessness* benefit it exists for goes unused |
| Cost if this later becomes a distributed, multi-replica service | Needs a shared store (e.g. Redis) instead of in-memory — a real, known migration path | Would need to be re-evaluated anyway, mainly for the revocation gap above |

## Decision

**Session-based authentication, with the session store in-process and the token
carried in an `HttpOnly`, `SameSite=Strict` cookie.** Concretely:

- `mcp-server/src/auth/credentials.ts` — password hashing via `node:crypto`'s
  `scryptSync`/`timingSafeEqual` (constant-time comparison; zero new dependencies).
- `sessionStore.ts` — a `SessionStore` with 60-minute sliding-expiry sessions
  (extends on each valid access, lazily expires on access), matching this codebase's
  existing injectable-clock pattern (`guardrails/hitlQueue.ts`,
  `reliability/circuitBreaker.ts`) so expiry is deterministically testable.
- `cookies.ts` — hand-rolled `Set-Cookie`/`Cookie` handling (one cookie; no need for
  the `cookie` npm package), `HttpOnly` + `SameSite=Strict` always on, `Secure`
  gated behind `SESSION_COOKIE_SECURE` so plain `http://localhost` keeps working in
  dev.
- Every route except `GET /`, `GET /health`, `GET /login`, `POST /api/login`, and
  `POST /api/logout` runs through a `requireSession()` guard.
- `GUARDRAIL_PRIMARY_APPROVER` now derives from `AUTH_USERNAME` — the real,
  verified login identity — instead of the unverified `OPERATOR_CONTACTS` display
  string, and `POST /api/guardrail/decide` passes the real `session.username` as
  `decidedBy`. This is the actual fix for the gap this ADR exists to close:
  `UnauthorizedDeciderError` is reachable now, and the audit trail's `actor`/
  `approver` fields reflect a person who really authenticated, not a constant.

This was not the default choice made by omission — JWT was the first option
considered, per the user's direct question ("Are you going to use JWT
authentication or Session based?"), and rejected for the reasons in the table
above, not because it's unfamiliar or harder to implement.

## Consequences

**What this requires, already built:**
- A session store that is currently in-memory and therefore process-local — a
  server restart logs everyone out. Acceptable today (single operator, easy
  re-login); see "What would change this decision" below.
- `AUTH_USERNAME`/`AUTH_PASSWORD_HASH` are read at module load and the server
  **fails fast** if either is unset — a deliberate exception to this file's usual
  "missing config → degrade gracefully" convention, since degrading gracefully here
  would mean silently serving with no real auth, which is worse than not starting.
- `dashboard.html`'s eleven raw `fetch()` calls were replaced with one shared
  `apiFetch()` wrapper that redirects to `/login` on any `401` — the same pattern
  any other consumer of this API must follow to handle session expiry correctly.

**What this explicitly does not cover (flagged, not silently skipped):**
- Multi-user credential storage — one `AUTH_USERNAME`/`AUTH_PASSWORD_HASH` pair,
  matching the current single-operator reality. Multiple real users would need a
  users table, not a second env var.
- MFA — `mfa: true` in the audit trail remains an honest placeholder; no MFA exists.
- Login rate-limiting or lockout after repeated failures.
- `frontend/`'s (the separate React/Vite app) own cookie/CORS handling — its
  deployment topology was undecided at the time this ADR's work landed, and was
  resolved separately and later (serving the built app from `mcp-server` itself,
  same-origin, closing the gap this decision would otherwise have left open for
  that consumer).

## What would change this decision

- **Horizontal scaling of `mcp-server` to multiple replicas** would break the
  in-memory `SessionStore` — a session created on one replica wouldn't be visible
  on another. The fix is a shared store (Redis, or the same database this system
  already uses elsewhere), not a switch to JWT — the revocation and
  storage-exposure reasons above still hold regardless of replica count.
- **A future need for third-party or cross-service API consumers** (not a browser
  session — a script, another service, a mobile app) would be a real reason to
  reconsider: that's the shape of problem JWT (or a separate API-key scheme) is
  actually built for, and this ADR's reasoning was scoped to "one operator, one
  browser, one process," not that case.
- **If revocation requirements loosen** (e.g., short-lived tokens become
  acceptable and instant revocation is no longer required), the cost-benefit shifts
  — but nothing in this system's current governance model calls for that.
