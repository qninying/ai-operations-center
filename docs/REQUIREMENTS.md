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
