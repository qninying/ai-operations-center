# ADR-008: An Evidence Grounding Check, Closing the "Confident but Wrong" Gap

**Status:** Implemented — built, unit-tested, and live-verified against a real Claude response with no false positive, plus a deliberate break test proving the failure path renders correctly.
**Owner:** Quincy Nkwain Ninying
**Date:** 2026-08-27
**Component:** `mcp-server/src/evidenceGroundingCheck.ts`, `recommendationService.ts`, `cloudRecommendationService.ts`, `correlatedRecommendationService.ts`, `dashboard.html`

---

## Context

A mock-skeptic Q&A rehearsal for the Expo talk surfaced the hardest question
this system faced: what stops a wrong-but-confident AI recommendation from
being approved and executed, given the human approver is reading the same
evidence and the same AI-generated explanation the model already reasoned
over?

The honest answer at the time was: nothing did. `remediationGuardrail.ts`
checks that an action is evidence-*linked* (`evidenceIds.length > 0`),
human-approved, and of an allowed reversible type — never that the citation
is real. `RootCauseResponseSchema` in `rootCauseAgent.ts` validates
`evidenceIdsUsed` as `string[]` and nothing more; there was no cross-check
against the evidence the model was actually given. A fluent, high-confidence
`rootCause` that cited a fabricated evidence ID, or cited nothing at all,
would reach a human approver with no independent signal distinguishing it
from a legitimate one.

## Decision drivers

| Driver | Source | Why it matters here |
|---|---|---|
| Close a real gap named in review, not a hypothetical one | The skeptic Q&A rehearsal | The gap was identified by naming a concrete failure scenario, not by speculative hardening. |
| Ship something provably correct, not something that might cry wolf | This repo's own "never fabricates a result when evidence is thin" value | A heuristic semantic check with real false-positive risk could flag legitimate output as suspicious, which is worse than not having the check at all. |
| No time pressure to rush this | Course content already complete; this is deliberate skill-building time, not demo-day prep | Justifies doing this properly — a real module, real tests, a real ADR — instead of a quick patch. |
| Match the existing "each source owns its own transform" convention | `correlatedRecommendationService.ts`'s own stated convention | A shared module that needed to know SQL/SSRS/Cloud field names would break that convention and need updating for every new source. |

## Options considered

| | **Citation-existence check, generic over opaque evidence (chosen)** | **A second "critic" LLM call** | **Per-source semantic verification** | **Outcome-based confidence calibration** |
|---|---|---|---|---|
| Actually independent | Yes — deterministic, no model call | No — same model family, same blind spots | Yes, but only per-source | Yes, but needs data that doesn't exist yet |
| False-positive risk | None — pure set membership | Low, but doubles cost/latency on every call | Moderate — depends on getting per-source rules right | N/A — long-term signal, not per-call |
| Coupling to source schemas | None — generic over `EvidenceItem.data: unknown` | None | High — needs SQL/SSRS/Cloud field knowledge, updated per new source | None |
| Buildable now, safely | Yes | Yes, but cost/latency tradeoff not clearly justified | Real work, real risk of getting rules wrong | No — requires an outcome-tracking feedback loop that doesn't exist |

**A second LLM call rejected**: not actually independent — a self-consistency
or "critic" pass from the same model family shares the same failure modes as
the first call, while doubling cost and latency on every recommendation for a
check that isn't provably better.

**Per-source semantic verification rejected for this version**: evidence
shapes are deliberately not unified across sources (SQL has
`blocking_session_id`, SSRS has `report_path`/`status`, Cloud has
`service`/`severity`/`message` — no shared field-level shape). A checker that
verifies the rootCause text is semantically consistent with those specific
fields would need to know all three shapes and be updated for every new
source, coupling a shared safety module to three independently-evolving
schemas. Real future work if there's a stronger case for accepting that
coupling — not rejected forever, rejected for now.

**Outcome-based calibration rejected for this version**: the real long-term
answer (track whether approved fixes actually resolved the incident,
recalibrate confidence over time) — but there is no outcome-tracking feedback
loop in this system today. Nothing currently confirms a fix worked, only that
it ran. Building that loop is separate, larger scope.

Confirmed directly with the user: scope this down from "verify the diagnosis
is correct" to "verify the citation is real" — a narrower, honestly-labeled
claim that's actually buildable with zero false-positive risk, rather than a
broader claim that can't be delivered safely in one pass.

## Decision

**`mcp-server/src/evidenceGroundingCheck.ts`** — a new, pure, deterministic
module mirroring `guardrails/remediationGuardrail.ts`'s own shape and
doc-comment convention (no I/O, safe to call on every recommendation):

```ts
export type GroundingViolation = "CITED_EVIDENCE_NOT_FOUND" | "NO_EVIDENCE_CITED";
export interface GroundingResult { grounded: boolean; violations: GroundingViolation[]; }
export function checkEvidenceGrounding(evidence: EvidenceItem[], evidenceIdsUsed: string[]): GroundingResult
```

`CITED_EVIDENCE_NOT_FOUND` fires when any cited id isn't in the evidence the
model was actually given — catches a hallucinated or invented citation
outright. `NO_EVIDENCE_CITED` fires when evidence existed but nothing was
cited — the model had something to point at and pointed at nothing.
Deliberately generic over `EvidenceItem.data: unknown` — no per-source field
knowledge, so it needs no changes when a new evidence source is added.

**Wired into each recommendation service's own return, not `httpServer.ts`.**
`evidence`/`incident` are local to each service function and never reach
`httpServer.ts` — the route handlers only ever saw the final
`RootCauseResult`. Each service now computes `grounding` right after its
existing `analyzeFn(incident)` call, following the exact precedent
`correlatedRecommendationService.ts` already set for its own
`partialCorrelation` field:

```ts
const result = await analyzeFn(incident);
const grounding = checkEvidenceGrounding(evidence, result.evidenceIdsUsed);
return { ...result, grounding };
```

`httpServer.ts` needed zero changes — its three route handlers already spread
`...result` into the JSON response, so `grounding` rides along automatically.

**Dashboard**: a third, independent banner (`.banner.ungrounded`) in
`dashboard.html`'s `troubleshootIncident()`, following the exact pattern of
the existing escalation banner — rendered alongside (not instead of) the
confidence number and root-cause text, since confidence, escalation, and
grounding are three independent signals that can coexist (a recommendation
can be high-confidence, not escalated, and still ungrounded).

**Scope decision: informational only, does not block Fix.** Matches how
escalation already behaves — Fix/Approve/Reject still render when escalated.
Blocking would need a defined alternate path ("send back for re-analysis")
that doesn't exist yet; inventing one here would be scope creep beyond what
this ADR closes.

## Consequences

**What this closes, verified for real, not just typed and compiled:**
- 7 new unit tests in `evidenceGroundingCheck.test.ts` (happy path, each
  violation individually, both possible states of a mixed real+fabricated
  citation list, the zero-evidence boundary, and the same purity test
  `remediationGuardrail.test.ts` established — identical input twice yields
  identical, unmutated output). `mcp-server` 255/255 passing (up from 248),
  `tsc --noEmit` clean.
- **Live-verified against a real Claude response, not a mock**: re-ran the
  SSIS/Cloud Troubleshoot flow used in Expo demo rehearsal against the real
  server. The real response came back `grounding: { grounded: true,
  violations: [] }` — the model legitimately cited the one real evidence item
  it was given, and the check correctly found nothing wrong. No false
  positive on genuine output.
- **A deliberate break test, not just the happy path**: temporarily
  substituted a fabricated response (`evidenceIdsUsed: ["evt-does-not-exist"]`,
  confidence 92%) into the real `window.troubleshootIncident()` function
  running in the live browser — not a hand-simulated DOM mutation. The
  ungrounded banner rendered correctly: `className: "banner ungrounded
  shown"`, visible, with the message *"This recommendation cites evidence
  that was never given to it — verify the evidence yourself before
  approving."* Test pollution (a fake correlation ID written into
  `localStorage`) was identified and cleaned up immediately after.

**What this explicitly does not cover (flagged, not silently skipped):**
- Causal correctness of the diagnosis itself. A recommendation can cite real,
  genuine evidence and still be grounded-but-wrong — this check only proves
  the citation is real, not that the conclusion drawn from it is right.
- Any per-source semantic check (e.g. that a claimed `blocking_session_id`
  actually matches the cited SQL evidence's real value).
- Blocking `Fix` on an ungrounded result — informational only, by deliberate
  scope decision above.

## What would change this decision

- **A recurring real false positive** (a legitimate response flagged
  ungrounded) would be the trigger to revisit the citation-matching logic —
  none has been observed yet, including in the live-verification pass above.
- **A concrete, low-risk way to add per-source semantic checks** without
  coupling this module to three independently-evolving schemas would be the
  trigger to revisit the rejected per-source option — e.g. if evidence types
  ever converge on a shared field-level shape for other reasons.
- **A real outcome-tracking feedback loop being built for other reasons**
  would be the trigger to revisit outcome-based calibration — it shouldn't be
  built solely to serve this ADR, but should be reused here if it exists.
