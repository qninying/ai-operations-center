# CoreOps AI Operations Dashboard — Requirements

An enterprise-grade AI Operations Dashboard for SQL Server, SSIS, SSRS, and Windows servers, providing intelligent command center capabilities with human approval for production changes.

This is the source of truth for what you are building. Your Claude Code prompts
point here. If you sharpen a requirement, edit it — your version is the real one.

| Kind | Meaning |
|---|---|
| Functional | something the system does |
| Safety | a guardrail, with a check that enforces it |
| Reliability | how it behaves when something fails |
| Constraint | a technology or vendor you must use — context, not a task |

## AI Analysis

### REQ-002 — Functional · must

The system must automatically detect, diagnose, correlate, and recommend actions without executing production changes.

Fulfilled by: STORY-003

### REQ-003 — Functional · must

The system must provide confidence scores for recommended actions.

Fulfilled by: STORY-003

### REQ-004 — Functional · must

The system must present evidence-backed reasoning for all recommendations.

Fulfilled by: STORY-003

### REQ-010 — Functional · must

The system must gather additional diagnostics when confidence is below 80%.

Fulfilled by: STORY-004

### REQ-011 — Functional · must

The system must escalate incidents to a human when confidence is below 60%.

Fulfilled by: STORY-009

### REQ-013 — Functional · must

The system must provide explainable AI recommendations for all users.

Fulfilled by: STORY-006, STORY-007

## Approval Workflow

### REQ-001 — Safety · must

The system must require human approval for any action that changes a production environment.

Fulfilled by: STORY-001

### REQ-015 — Safety · must

The system must support rollback capabilities for low-risk, reversible tasks.

Fulfilled by: STORY-011

### REQ-019 — Safety · should

The system must verify that an AI recommendation's cited evidence is real
before presenting it as an actionable, approvable recommendation.

Fulfilled directly, not through a platform story (this requirement was never
assigned a STORY id in `.colaberry/plan.json`, and was identified after the
plan was written — see ADR-008). `mcp-server/src/evidenceGroundingCheck.ts`
cross-checks `evidenceIdsUsed` against the evidence the model was actually
given, flagging a citation to evidence that doesn't exist, or a diagnosis
that cites nothing when real evidence was available. Wired into all three
recommendation pipelines (`recommendationService.ts`,
`cloudRecommendationService.ts`, `correlatedRecommendationService.ts`) and
surfaced as an independent "unverified citation" banner in `dashboard.html`,
alongside (not instead of) the existing confidence/escalation signals.

This closes a real gap named directly by a hard question in demo-prep review
(2026-08-27): the guardrail (`guardrails/remediationGuardrail.ts`) checks
that an action is evidence-*linked* and human-approved, never that the
citation is genuine — a confident, fluent, but fabricated citation would
previously reach a human approver with no independent signal at all. This
does not verify causal correctness of the diagnosis itself (that a cited,
real piece of evidence actually supports the stated conclusion) — that
remains open, named explicitly in ADR-008 as future work, not solved here.

### REQ-020 — Safety · should

The system must verify that an AI recommendation's specific factual claims
about cited evidence actually match what that evidence contains, not just
that the citation exists.

Fulfilled directly, not through a platform story (identified after the plan
was written, one level deeper than REQ-019 — see ADR-009). Extends
`mcp-server/src/evidenceGroundingCheck.ts` with a structured claim check:
`rootCauseAgent.ts` now asks the model for `{text, evidenceId, field,
value}` entries alongside its prose root cause, and each claim's field/value
is verified against the real cited evidence, catching a citation that's real
but misstated — not just a fabricated one (REQ-019's scope). Live-verified
against a real Claude response that complied correctly on the first
attempt, and a deliberate break test proving the failure path renders.

This does not verify the overall diagnosis is causally correct — a
recommendation can get every individual claim right and still draw the
wrong conclusion from them. That remains open, named explicitly in ADR-009.
The human approval requirement is unaffected by design: this makes the
approver's review better-informed, not less necessary.

## Audit Trail

### REQ-005 — Safety · must

The system must log every decision and action for audit purposes.

Fulfilled by: STORY-002

## Configuration

### REQ-014 — Functional · should

The system must allow configuration of confidence thresholds for actions.

Fulfilled directly, not through a platform story (this requirement was never
assigned a STORY id in `.colaberry/plan.json` — a `should`, not a `must`, so it
wasn't gating the plan). `mcp-server/src/confidenceThresholds.ts` reads each of
the three real thresholds this system acts on — `rootCauseAgent.ts`'s
insufficient-evidence cutoff, `diagnosticsGatherer.ts`'s differential-gathering
cutoff, `escalationService.ts`'s human-escalation cutoff — from an optional env
var each, validated and fail-fast on a malformed value, falling back to the
existing default when unset. See `mcp-server/.env.example`.

## Efficiency

### REQ-017 — Non-functional · should

The system must reduce manual incident correlation across systems by 50-70%.

Fulfilled directly, not through a platform story (this requirement was never
assigned a STORY id in `.colaberry/plan.json` — a `should`, not a `must`, so it
wasn't gating the plan). `mcp-server/src/correlatedRecommendationService.ts`
and `GET /api/correlated-recommendation` gather live evidence from SQL Server
DMVs and SSRS ExecutionLog3 for one incident in a single call and hand it all
to `analyzeIncidentRootCause()` together — the manual step this requirement
names (a human separately querying SQL Server, separately querying SSRS, then
cross-referencing both outputs by hand) now has a real, working alternative
where none existed before. Correlation happens at the LLM reasoning layer,
not a fabricated join key — `DmvExecRequestRow` and `SsrsExecutionLogRow`
share no real key in this codebase, so building one would mean inventing data
that doesn't exist.

This closes the functional gap: cross-system evidence gathering did not exist
in any code path prior to this change. It does not, and cannot yet,
demonstrate the literal 50-70% figure — that requires production usage
history to measure against, which does not exist yet.

## AI Governance & Compliance

Identified 2026-09-10 by reviewing CoreOps against Weights & Biases' "Governance
workflows for AI agents" review-gate pattern (Intake, Scope, Assess, Probe,
Decide). That review confirmed CoreOps is strong on execution governance
(approval, identity, audit) but has no repeatable adversarial evaluation of the
LLM's own outputs, no standalone risk-scoping artifact, and no mapping of its
existing evidence to a named regulatory framework. None of the three below are
built yet; each is written with enough detail to build from directly.

### REQ-021 — Safety · should

The system's LLM-driven recommendation and remediation pipeline must be tested
against adversarial inputs (prompt injection, jailbreak attempts, PII
extraction, hallucinated citations) with a repeatable evaluation suite, not a
one-off manual check.

Status: partially fulfilled directly — `mcp-server/src/adversarialEval/`, no
platform story assigned. The indirect (context-smuggled) injection category is
built: three probes, run via `npm run eval:adversarial` against the real
`analyzeIncidentRootCause()` and the real Anthropic API, severity-scored, and
logged to the real audit trail per probe run. Live-verified 2026-09-10, all
three held against the real API. Direct injection, jailbreak-vs-allowlist, and
leakage/hallucination-under-pressure are not built yet — see
`docs/adversarial-eval-design.md` and the PROGRESS.md entry for this date.

How to build it: see `docs/adversarial-eval-design.md` for the full design,
probe taxonomy, and implementation checklist. In short, extend the eval
harness with an adversarial probe set covering, at minimum, prompt injection
(direct and indirect/context-smuggled), jailbreak attempts against the
remediation allowlist in `guardrails/remediationGuardrail.ts`, PII leakage in
generated summaries, and hallucinated evidence citations (building on the
REQ-019/REQ-020 grounding checks already in place). Score severity per probe,
not just pass/fail, and fail the suite on any critical-severity success
regardless of aggregate resistance rate.

Failure paths to handle: a probe logs the dangerous behavior instead of
asserting on it; a new prompt or model version ships without the suite being
re-run; the suite exercises a guardrail code path that isn't actually in the
production call path.

### REQ-022 — Safety · should

The system must have a written, reviewable risk-scoping artifact, declaring
deployment context, data types handled, capabilities, and risk tier,
independent of the code.

Status: proposed, not yet built. This information currently lives only
implicitly in guardrail code (`sqlRemediationSafety.ts`, `abacPolicy.ts`), not
anywhere a compliance reviewer could read without reading source.

How to build it: a single `docs/AI-GOVERNANCE-PROFILE.md` stating system
owner, deployment context (internal ops tool, not customer-facing), data
types handled (operational telemetry, DB session metadata; explicitly state
that PHI/PII is not currently in scope), capabilities (diagnose, recommend,
execute-with-approval), and a stated risk tier with the reasoning behind it
(elevated, because the system can execute infrastructure changes, even though
every execution is approval-gated).

Failure paths to handle: the artifact drifts from the actual code as new
capabilities ship; it gets written once and never revisited.

### REQ-023 — Safety · should

The system's existing guardrail and audit evidence must be explicitly mapped
to at least one named regulatory framework (NIST AI RMF functions, at
minimum), so a reviewer can see framework coverage without inferring it from
source code.

Status: proposed, not yet built. No reference to NIST AI RMF, EU AI Act, or
ISO/IEC 42001 exists anywhere in this repo today. The "governance" and
"compliance" language that does exist (README's Governance & security
section, ADR-005, ADR-006, STORY-002's Compliance Officer persona) is real
but unmapped to any named framework.

How to build it: a coverage table, alongside REQ-022's profile or in a
sibling `docs/FRAMEWORK-MAPPING.md`, mapping each existing guardrail or
evidence source to the NIST AI RMF function it satisfies, for example the
approval queue, MFA, and audit log together to MANAGE; ABAC deny-by-default to
GOVERN; the REQ-021 adversarial suite, once built, to MEASURE. Cite the
specific file or ADR as evidence for each row, the way `docs/TRACEABILITY.md`
already does for requirement-to-story.

Failure paths to handle: the mapping claims coverage a mechanism doesn't
actually provide; it isn't kept current as new ADRs land.

## Integration

### REQ-007 — Constraint

The system must support integration with SQL Server, SSIS, SSRS, and Windows servers.

Fulfilled by: STORY-006

### REQ-008 — Constraint

The system must support integration with cloud services and enterprise applications through standardized connectors.

Fulfilled by: STORY-007

### REQ-018 — Constraint

The system must provide a plug-in connector architecture for extensibility.

Context for the stories that use it — constraints do not get their own story.

## Monitoring

### REQ-016 — Functional · must

The system must provide continuous monitoring and AI-powered root cause analysis.

Fulfilled by: STORY-008

## Notification

### REQ-012 — Safety · must

The system must notify operators immediately of any autonomous actions taken.

Fulfilled by: STORY-010

## User Interface

### REQ-006 — Functional · must

The system must provide role-based dashboards for different user types.

Fulfilled by: STORY-005

### REQ-009 — Functional · must

The system must provide operational summaries for IT Managers and Engineering Leaders.

Fulfilled by: STORY-005
