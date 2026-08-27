# ADR-009: Structured Claim Verification, One Level Deeper Than Citation Grounding

**Status:** Implemented — built, unit-tested, and live-verified against a real Claude response that complied correctly on the first attempt, plus a deliberate break test proving the failure path renders correctly.
**Owner:** Quincy Nkwain Ninying
**Date:** 2026-08-27
**Component:** `mcp-server/src/rootCauseAgent.ts`, `mcp-server/src/evidenceGroundingCheck.ts`, `dashboard.html`

---

## Context

ADR-008 closed one gap: proving an AI recommendation's cited evidence IDs
are real. It explicitly did not prove the recommendation's specific factual
claims are *accurate* — a response can cite `evt-1` legitimately and still
misstate what `evt-1` actually says (e.g. claim session 61 is blocked by
session 999 when the real `blocking_session_id` is 52). ADR-008 named this
directly as future work rather than pretending citation-grounding solved it.

This surfaced again directly in review: asked "so basically a DBA still
needs to validate the fix, right?" — yes, unconditionally, and that doesn't
change no matter how good this check gets. What changes is how well-informed
that validation is. This ADR is one more layer of informing it, not a step
toward removing it.

**A materially different risk profile than ADR-008.** ADR-008 was pure
post-processing — it changed nothing about what was asked of the live
Claude call, so there was zero risk of degrading the model's actual
behavior. This change asks the model to produce a new structured field
(`claims`) it had never been asked for before. That carries real compliance
risk: the model might not reliably populate it, or might reference field
names loosely. The design below is built so a model that complies poorly
degrades to exactly the pre-ADR-009 behavior (no new claims, no new
violations) rather than breaking anything.

## Decision

**Schema** (`rootCauseAgent.ts`): `RootCauseResponseSchema` gains an
optional, defaulted `claims` array —
`z.array(ClaimSchema).optional().default([])`, where `ClaimSchema` is
`{ text, evidenceId, field, value }`, all plain strings. Optional and
defaulted specifically so a response that omits the field (or an older
cached prompt behavior) is not a parse failure. Confirmed against
`rootCauseAgent.test.ts`'s 10 existing tests (none construct a `claims`
field) that this degrades safely — all 10 kept passing unmodified.

**Prompt** (`buildPrompt()`): one new instruction, deliberately scoped —

> For each specific fact in your rootCause that is drawn directly from one
> field of one piece of evidence — not inference or synthesis across
> multiple items — add an entry to claims naming the exact evidenceId, the
> literal field name from that evidence's data, and its literal value as a
> string. Only include claims you can point to one literal field for; do
> not force synthesis or inference into a claim.

Deliberately tells the model not to force every sentence into a claim —
legitimate synthesis across multiple evidence items can't be reduced to one
field=value pair, and penalizing that would punish the actual reasoning this
system exists to do.

**Verification** (`evidenceGroundingCheck.ts`, extended, not a new module):
a new `CLAIM_NOT_SUPPORTED_BY_EVIDENCE` violation. For each claim, if its
`evidenceId` isn't known, it reuses the existing `CITED_EVIDENCE_NOT_FOUND`
(same underlying problem). If it is known, the claimed `field`/`value` is
checked against the evidence's real data with a case-insensitive, trimmed
exact-string comparison — not fuzzy semantic matching, the same
false-positive risk ADR-008 already declined to take on. **An empty
`claims` array is never itself a violation** — nothing to verify isn't
evidence of a problem, matching the conservative stance the whole grounding
check already takes.

## Consequences

**What this closes, live-verified, not just typed and compiled:**
- 9 new tests (2 in `rootCauseAgent.test.ts`, 7 in
  `evidenceGroundingCheck.test.ts` — a matching claim, a wrong value, a
  claim referencing a nonexistent field, a claim citing unknown evidence
  (reuses `CITED_EVIDENCE_NOT_FOUND`), case/whitespace tolerance, empty
  claims staying grounded, and no duplicate violations for repeated
  problems). `mcp-server` 264/264, `tsc --noEmit` clean.
- **Live-verified against a real Claude response, and it complied
  correctly on the first attempt** — re-ran the same SSIS/Cloud
  Troubleshoot flow used throughout this session's verification passes. The
  real response's one claim cited `field: "message"` with a value that
  exactly matched the real evidence record's literal `message` field, and
  `grounding` correctly came back `{ grounded: true, violations: [] }`. No
  prompt iteration was needed — the conservative, narrowly-scoped
  instruction worked as designed on the first real call.
- **A deliberate break test**: the same `window.troubleshootIncident()`
  substitution technique as ADR-008, this time with a claim whose value
  (`999`) doesn't match the real evidence's `blocking_session_id` (`52`).
  The ungrounded banner rendered correctly: *"This recommendation makes a
  specific factual claim that doesn't match the evidence it cites."*

**What this explicitly does not cover (flagged, not silently skipped):**
- Causal correctness of the overall conclusion. A recommendation can get
  every individual claim right and still draw the wrong conclusion from
  them — this checks facts, not the reasoning connecting them.
- Blocking `Fix` on an ungrounded result — still informational only, same
  scope decision as ADR-008, for the same reason (no defined re-analysis
  path exists yet).
- **The human approval requirement is untouched by design, not by
  omission.** Nothing in ADR-008 or this ADR is meant to make the approver's
  review less necessary — only better-informed. A gate that gives the
  approver the actual claims/evidence to review before Approve is enabled
  (rather than a generic confirmation dialog, which trains reflexive
  dismissal rather than genuine review) was discussed as the natural next
  step and deliberately deferred to its own scoped change, not folded into
  this one.

## What would change this decision

- **The live model failing to comply with the claims instruction in a
  future call** (empty claims on responses that clearly contain
  single-field facts, or malformed claim shapes) would be the trigger to
  revise the prompt wording — not observed in this pass, but only tested
  against one real scenario so far.
- **A genuine need to verify claims spanning synthesis/inference across
  multiple evidence items** would be the trigger to revisit the
  single-field-only scope — deliberately not attempted here, since a
  cross-evidence semantic check reintroduces the fuzzy-matching
  false-positive risk this design was built to avoid.
