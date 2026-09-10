# AI Governance Profile

REQ-022. A written, reviewable declaration of what this system is, what it touches, and how risky it is, independent of the code, so a reviewer doesn't have to read source to answer those questions.

## System identity

- **System:** CoreOps AI Operations Dashboard
- **Owner:** Quincy Nkwain Ninying
- **Repo:** [github.com/qninying/ai-operations-center](https://github.com/qninying/ai-operations-center)

## Deployment context

Runs locally (`npm run http`, `http://localhost:8787`) against a real development SQL Server, Postgres, and Docker stack. It is **not** deployed to production infrastructure serving a real company's systems.

This matters for reading the risk tier below correctly: the tier is scored against what the architecture is *designed* to be capable of, restarting a real service, killing a real database session, failing over a real replica, not today's literal exposure, which is limited to a local dev stack under the operator's own control. If this system is ever pointed at real production infrastructure, this profile, the risk tier, and every guardrail's real-world stakes need re-review before that happens, not after.

## Data types handled

- Operational telemetry only: SQL Server DMV rows (session and blocking data), SSRS execution logs, cloud and Docker service logs, Postgres backend and session state.
- Internal service account and login identifiers appear in evidence (for example `svc_etl`), system identifiers, not customer or employee personal data.
- No PHI, no customer PII, no payment data anywhere in this system today, confirmed directly by search, not assumed.
- If a future data source introduces PHI or PII, this profile and REQ-021's leakage-category adversarial probes (`mcp-server/src/adversarialEval/probes.ts`) must both be revisited before that source ships, not after.

## Capabilities

| Capability | What it actually does | Where |
|---|---|---|
| Diagnose | Correlates evidence and produces a root-cause explanation with a confidence score | `mcp-server/src/rootCauseAgent.ts` |
| Recommend | Proposes one specific action from a fixed, hardcoded allowlist, never an open-ended action | `guardrails/remediationGuardrail.ts` |
| Execute, gated | A proposed action only runs after a real, authenticated, MFA-verified human approves it | `guardrails/hitlQueue.ts`, `guardrails/abacPolicy.ts` |
| Monitor | Polls for new incidents on a schedule | `mcp-server/src/monitoringService.ts` |
| Notify | Alerts operators when an automated action is taken | `mcp-server/src/notificationService.ts` |
| Audit | Every decision and action durably logged, correlation-ID-linked, immutable | `guardrails/auditLog.ts` |

## Risk tier: Elevated

Not "critical", not "low." The reasoning, plainly:

- **What pushes it up:** the system can propose real infrastructure-changing actions, restart a service, kill a blocking database session, fail over to a replica. That's a real, if narrow, blast radius if something goes wrong. Its diagnostic reasoning is also LLM-driven and reads external evidence as context, a genuine prompt-injection surface.
- **What keeps it from being higher:** the action set is a small, hardcoded, reviewed allowlist, not open-ended, and execution is deterministically blocked without a real authenticated human's MFA-verified approval, every time, no exceptions in the code. The injection surface is actively tested, not just assumed safe, REQ-021's adversarial eval suite (7 probes across direct injection, indirect injection, social-engineering-style jailbreak attempts, and leakage/hallucination-under-pressure) held against the real API as of 2026-09-10, and REQ-019/020's grounding checks catch fabricated or misstated citations before a human sees them.
- **What keeps it from being lower:** no PHI or PII is in scope today, which is genuinely a mitigating factor, but the architecture still executes real, if reversible-by-design, production-class actions once approved, and that alone rules out treating this as low-risk internal tooling.

## Review

This is a snapshot, not a standing guarantee. Revisit it whenever a new data source, a new capability, or a real (non-dev) deployment target is added, tied to those material changes, not a fixed calendar date, since this system's risk profile moves in discrete jumps (a new data type, a new action type) rather than gradually.
