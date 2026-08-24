# ADR-006: Real TOTP-Based MFA, Replacing the Hardcoded `mfa: true`

**Status:** Implemented — built, unit-tested against published RFC 6238 vectors, and live-verified against the running server (including a real replay-protection check).
**Owner:** Quincy Nkwain Ninying
**Date:** 2026-08-24
**Component:** `mcp-server/src/auth/totp.ts`, `mcp-server/src/httpServer.ts`, `guardrails/hitlQueue.ts`

---

## Context

An INPACT trust-posture assessment flagged `mfa: true` in `httpServer.ts`'s call to
`hitlQueue.decide()` as an honest placeholder — `guardrails/hitlQueue.ts`'s `decide()`
genuinely enforces an MFA requirement (`if (!mfa) throw MfaRequiredError`, with a real
`"rejected_no_mfa"` audit entry), but the only call site passed a hardcoded `true`
literal, never a real second-factor check. Architecturally this is the same shape as
the bug ADR-003 fixed for `GUARDRAIL_PRIMARY_APPROVER`: the enforcement logic was real,
nothing upstream ever actually verified anything. `httpServer.ts` even had an existing
comment next to that line admitting this plainly: "MFA itself is still not implemented
anywhere in this system, so `true` remains an honest stand-in for that one factor only,
not a claim that a real MFA challenge happened."

## Decision drivers

| Driver | Source | Why it matters here |
|---|---|---|
| Close a named, previously-honest gap | The trust scorecard's own Identity-dimension finding | The gap was already documented as accepted debt, not hidden — closing it directly answers that finding. |
| Zero new dependencies | This repo's "new dependencies require a deliberate add" rule | `node:crypto`'s HMAC-SHA1 covers RFC 6238's algorithm completely — no reason to add one. |
| Works fully offline | Single-operator, low-frequency-login internal tool | No SMS/email delivery service to depend on, pay for, or have fail at the worst moment. |
| Match existing code style | `credentials.ts` (hand-rolled scrypt), `sessionStore.ts`/`rateLimiter.ts` (injectable-clock classes) | A third hand-rolled auth primitive in the same idiom is easier to review and trust than a fourth pattern. |

## Options considered

| | **TOTP, hand-rolled (chosen)** | **OTP via existing ntfy.sh channel** | **WebAuthn / passkeys** |
|---|---|---|---|
| New dependency | None | None | Likely yes, or substantial hand-rolled protocol code |
| Works offline | Yes | No — depends on ntfy.sh delivery | Yes (hardware-backed) |
| Security strength | Standard, well-understood (RFC 6238) | Weaker — an OTP on a public ntfy topic is a meaningfully weaker story than TOTP's cryptographic properties | Strongest — phishing-resistant |
| Implementation cost | Small — one module, HMAC-SHA1 already in `node:crypto` | Small, but reuses a channel built for a different purpose | Large — new dependency or substantial protocol code |
| Fit for current scale | Matches a single-operator internal tool | Adds an availability dependency for no real security gain here | Disproportionate to current scale |

Option B was rejected specifically for being a weaker security story while still
costing real implementation effort. Option C was rejected as disproportionate
complexity for what this system actually needs today — worth revisiting if this
stops being a single-operator tool (see "What would change this decision" below).

## Decision

**TOTP (RFC 6238), hand-rolled with `node:crypto`, gating `POST /api/login` directly.**

- `mcp-server/src/auth/totp.ts` — base32 encode/decode (RFC 4648, `node:crypto` has
  no built-in support), `generateTotpCode()` (HMAC-SHA1 + RFC 4226 dynamic
  truncation), `buildOtpAuthUri()` (standard Key URI for manual authenticator-app
  entry — no QR code image generation; hand-rolling a correct QR encoder is
  genuinely complex and disproportionate here, and every mainstream authenticator
  app accepts manual base32 entry), and `TotpVerifier` (drift-tolerant, ±1 step by
  default, with replay protection via a tracked `lastAcceptedTimestep`).
- `POST /api/login` now requires a third field, `totpCode`, validated in the same
  combined, non-distinguishing check as username/password (one generic
  `401 INVALID_CREDENTIALS` either way — revealing which factor was wrong would let
  a caller enumerate valid credentials or probe the second factor specifically).
- `mcp-server/src/auth/generateTotpSecret.ts` (one-time setup CLI, mirroring
  `hashPassword.ts`'s existing pattern) and
  `mcp-server/src/auth/printCurrentTotpCode.ts` (non-interactive current-code CLI,
  needed so `.claude/skills/demo-start/SKILL.md` and `demo-stop/SKILL.md` — both of
  which `curl` the login route without a human present — keep working).

### The design collapse: no new session-level MFA state

`hitlQueue.decide()`'s own existing comment said "...and only with MFA **on the
session**" — the original intent was session-level MFA, verified at login, not a
fresh per-decision code entry. Since `POST /api/login` now requires a valid TOTP
code to issue a session at all, **every session is inherently MFA-verified by
construction** — `hitlQueue.decide(..., true)` stops being a hardcoded lie and
becomes an accurate statement. No new field was added to `Session`/
`sessionStore.ts`; a boolean that would always be `true` by construction carries no
information a fresh read of "did this session's login require TOTP" doesn't already
give.

**The tradeoff this accepts, stated plainly rather than glossed over:** a stolen
session cookie could ride on that one login's MFA for the full 60-minute session
TTL, versus a fresh-per-decision TOTP re-entry, which would bound exposure to a
single `decide()` call. For a single-operator internal tool where `HttpOnly` +
`SameSite=Strict` (ADR-003) already closes the two likeliest cookie-theft vectors
(XSS exfiltration, CSRF), that residual risk is accepted now — the same honesty
standard ADR-003 itself set by flagging `mfa: true` plainly instead of declaring
victory prematurely.

## Consequences

**What this requires, already built and verified:**
- Real MFA enrollment is a one-time manual step (`npm run generate-totp-secret`,
  paste into `.env`, enter into an authenticator app) — no in-app enrollment UI,
  matching this repo's existing single-operator, env-var-based auth config pattern
  (`AUTH_USERNAME`/`AUTH_PASSWORD_HASH`).
- `httpServer.ts` fails fast at startup if `MFA_TOTP_SECRET` is unset, same
  deliberate exception to "degrade gracefully" as the existing auth config.
- Live-verified end to end against the real running server: missing code → real
  `400`; wrong code → real generic `401`; correct code → real `200` + session
  cookie; **replaying the exact same request (same code) → real rejection**, even
  with correct username/password — proving replay protection works, not just
  passing in isolation; the full `POST /api/guardrail/propose` →
  `POST /api/guardrail/decide` flow still succeeds afterward with the MFA-verified
  session; a real login through the browser UI; and the updated `demo-start`
  skill's login step succeeding non-interactively.
- 17 new unit tests in `totp.test.ts`, verified against the **published RFC 6238
  Appendix B SHA1 test vectors** (not just internal generate-then-verify
  self-consistency) — this is the correctness-critical core of the whole feature.
  `mcp-server` 184/184, `guardrails` 57/57, `tsc --noEmit` clean throughout.

**What this explicitly does not cover (flagged, not silently skipped):**
- No QR code image generation (flagged above) — manual/URI entry only.
- No in-app enrollment flow — one-time CLI + manual authenticator-app entry only.
- No per-decision re-verification of TOTP (the accepted tradeoff above).
- Still single-operator: one `MFA_TOTP_SECRET`, matching the existing single
  `AUTH_USERNAME` reality — multiple real operators would need per-user secrets,
  not a second env var.

## What would change this decision

- **A second real operator** — the current design assumes one secret for one
  person; multi-user MFA needs per-user secret storage, not this env-var pattern.
- **This system stops being reachable only by someone with `.env` access for
  non-interactive logins** — if `demo-start`/`demo-stop`-style automation ever runs
  somewhere less trusted than a developer's own machine, `printCurrentTotpCode.ts`'s
  trust assumption (filesystem access to `.env` already implies holding the secret)
  needs revisiting.
- **Compliance requirements for phishing-resistant MFA specifically** — TOTP is
  vulnerable to real-time phishing (a fake login page relaying a stolen code
  immediately) in a way WebAuthn is not; if that threat model becomes real for this
  system, Option C from the table above is the correct next step, not a TOTP
  variant.
