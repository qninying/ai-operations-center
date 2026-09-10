# NIST AI RMF Framework Mapping

REQ-023. Maps CoreOps's existing guardrail, evaluation, and audit evidence to the four NIST AI RMF functions, GOVERN, MAP, MEASURE, MANAGE, so a reviewer can see framework coverage without inferring it from source.

This does not certify NIST AI RMF compliance. No code-level artifact can, a real compliance determination needs legal and model-risk review this document isn't a substitute for. It organizes the technical evidence that review would work from, the same distinction Weights & Biases' own "Governance workflows for AI agents" toolkit draws about itself, and the review that prompted REQ-021/022/023 in the first place.

## GOVERN

Worth stating up front, not burying: GOVERN is substantially a process function, organizational policy, defined roles across more than one person, a recurring governance review cadence, not something architecture alone satisfies. What's below is real, partial evidence, not full coverage. The same W&B toolkit that prompted this review marks its own GOVERN coverage as "not applicable, process-level requirement, no scorer-measurable controls" for exactly this reason.

| Evidence | What it actually establishes | Where |
|---|---|---|
| Deny-by-default access policy (ABAC) | Who may act, on what, under what role, fails closed on no matching rule | `guardrails/abacPolicy.ts`, `guardrails/abacEvaluator.ts` |
| Hardcoded, reviewed action allowlist | Bounds what the system may ever propose; extending it is a real, deliberate governance-boundary change (ADR-010) | `guardrails/remediationGuardrail.ts` |
| Named owner, stated risk tier | The one written governance artifact this system has | `docs/AI-GOVERNANCE-PROFILE.md` (REQ-022) |
| Real second-approver identity, not a placeholder | A decision traces to an actual person, not a hardcoded string (ADR-007) | `mcp-server/src/auth/userDirectory.ts` |

**Not covered, honestly:** a documented incident-response runbook beyond code, a multi-person review board, a recurring governance review cadence. This is a solo project; parts of GOVERN's real substance can't be demonstrated by architecture alone, and this table doesn't pretend otherwise.

## MAP

| Evidence | What it actually establishes | Where |
|---|---|---|
| Deployment context, data types, capabilities | Documents intended use and scope before risk is assessed | `docs/AI-GOVERNANCE-PROFILE.md` |
| Domain-specific safety assessment | Categorizes which incidents are safe to automate versus require human judgment, real DBA rules, before any action is proposed | `mcp-server/src/sqlRemediationSafety.ts`, `pgRemediationSafety.ts` (ADR-010, ADR-013) |
| Stated risk tier with for/against reasoning | Explicit categorization of overall system risk, not a bare label | `docs/AI-GOVERNANCE-PROFILE.md` |

## MEASURE

| Evidence | What it actually establishes | Where |
|---|---|---|
| Adversarial eval suite, 7 probes across 4 categories | Repeatable measurement of AI-behavior risk (injection, jailbreak, leakage, hallucination-under-pressure), not just task correctness | `mcp-server/src/adversarialEval/` (REQ-021) |
| Evidence-grounding and structured-claim verification | Measures whether a citation is real and accurately quoted before a human ever sees it | `mcp-server/src/evidenceGroundingCheck.ts` (REQ-019, REQ-020, ADR-008, ADR-009) |
| Prompt-correctness eval harness | Measures task correctness against a labeled eval set | `scripts/score_prompt.py` |
| Automated test suite | Measures code-level correctness under both happy-path and failure-path scenarios | `mcp-server/`, `guardrails/` test suites |

## MANAGE

| Evidence | What it actually establishes | Where |
|---|---|---|
| Human-in-the-loop approval queue, MFA-gated, timeout escalation | Real-time risk response: nothing executes without a decision, and a stalled decision doesn't sit silently | `guardrails/hitlQueue.ts` |
| Durable, correlation-ID-linked audit trail | The record a real after-the-fact incident review works from | `guardrails/auditLog.ts` (ADR-005) |
| Circuit breaker on upstream calls | Automated containment when an external dependency degrades | `mcp-server/src/reliability/circuitBreaker.ts` |
| Continuous monitoring and operator notification | Ongoing operational awareness of autonomous actions taken | `mcp-server/src/monitoringService.ts`, `notificationService.ts` |
| Human-attested outcome recording | Closes the loop on whether an approved fix actually worked, not just that it ran | `POST /api/guardrail/outcome` (`mcp-server/src/httpServer.ts`) |

## What this mapping does not do

- It does not certify compliance with anything. It's evidence organization, not a legal determination.
- It's current as of 2026-09-10. A new ADR that touches a guardrail, evaluation, or audit mechanism and isn't reflected here is exactly the failure path REQ-023 itself names, revisit this table when that happens, not on a fixed calendar date.
- EU AI Act and ISO/IEC 42001 mapping isn't attempted here. REQ-023 scoped this to NIST AI RMF "at minimum" on purpose, a broader mapping is a distinct, larger future addition, not silently implied by this document existing.
