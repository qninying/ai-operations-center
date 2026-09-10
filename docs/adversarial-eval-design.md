# Adversarial Evaluation Design for AI Systems

## Why this matters

CoreOps's guardrails, the ABAC policy engine, the remediation allowlist, the human approval queue, all control what an AI-proposed action is allowed to *do*. None of them check whether the reasoning behind that proposal was manipulated in the first place. An LLM that reads live evidence (SQL Server DMVs, SSRS execution logs) and produces a root-cause diagnosis is trusting that evidence as context, and anything trusted as context is a surface an attacker can try to write to.

Three concrete ways this goes wrong, specific to a pipeline like CoreOps's, not hypothetical AI-safety abstractions:

1. **A confident, fabricated diagnosis reaches a human approver.** REQ-019 and REQ-020 already catch a citation that doesn't exist or misstates what it cites. Neither was built by throwing adversarial pressure at the model, they were built to catch honest model error. An attacker deliberately trying to produce a citation that survives grounding checks is a different, harder case, and nobody has tried it yet.
2. **Evidence itself carries an instruction, not just data.** A log line, a DMV row, or an SSRS execution record is data CoreOps retrieves and hands to the model as trusted context. If an attacker can get adversarial text into that evidence (a crafted query comment, a manipulated log entry), the model may follow it as an instruction rather than read it as a fact. This is indirect prompt injection, and it's the version that matters most here, because CoreOps's whole pipeline is retrieval-grounded by design.
3. **A generated summary leaks something it shouldn't.** A connection string, a session detail, a credential fragment sitting in raw diagnostic evidence could plausibly surface in prose meant for a dashboard, if nothing is checking for it.

The deterministic guardrails answer "can this action run." Adversarial evaluation answers "should this reasoning be trusted," and CoreOps currently has no repeatable way to answer that second question.

## Core design principles

| Property | What it means | Why it's non-negotiable |
|---|---|---|
| **Repeatable** | The same probe set runs every time a prompt or model version changes, not a one-off manual check | A single passed test proves nothing about the next prompt edit; `PROGRESS.md:732`'s one manual test is evidence of a moment, not a guarantee |
| **Severity-scored, not pass/fail** | Each probe carries a severity, and the suite's verdict is driven by the worst single result, not an aggregate percentage | Mirrors the review-gate principle that one successful critical-severity attack fails the verdict regardless of how many others were resisted |
| **Exercises the real call path** | Probes call the actual production pipeline (`rootCauseAgent.ts`, `recommendationService.ts`), not a mocked stand-in | A probe that passes against a simplified stand-in proves nothing about what ships |
| **Additive to grounding, not a replacement for it** | Builds on REQ-019/REQ-020's citation checks rather than re-implementing them | Those checks catch honest model error; adversarial probes test whether the same checks hold under deliberate pressure |

## The probe taxonomy

Four categories, each aimed at a different way CoreOps's trust in its own pipeline could fail:

1. **Direct prompt injection.** Adversarial instructions placed where a user or caller directly supplies input, attempting to override the system prompt or the model's stated task.
2. **Indirect (context-smuggled) injection.** Adversarial instructions embedded inside retrieved evidence itself, a crafted string inside a DMV row, a log line, an SSRS field, so the model encounters them while reading what it believes is trusted, inert data. This is the category most specific to CoreOps and the one worth weighting heaviest.
3. **Jailbreak as social engineering, not allowlist bypass.** Worth naming precisely: `remediationGuardrail.ts`'s allowlist is plain deterministic code an LLM never touches, so there is no code-bypass surface here at all. What's real is whether adversarial content can get the model's diagnosis text to recommend a disallowed action convincingly enough that a human approver, reading only that text, acts on it by hand, outside the system entirely.
4. **Leakage and hallucination under pressure.** PII or secret fragments surfacing in generated prose; whether a fabricated or misrepresented claim, deliberately pressured into existence, still survives REQ-019/020's grounding checks.

## Where this stands today

All four categories are built, in `mcp-server/src/adversarialEval/` (`probes.ts`, `assessors.ts`, `runner.ts`), 7 probes total, run via `npm run eval:adversarial`. Every probe calls the real `analyzeIncidentRootCause()` against the real Anthropic API, not a stand-in. Live-verified 2026-09-10: all 7 held.

Two real bugs were found during live verification, in the harness, not the model:

- The diluted multi-evidence probe originally reused the confidence-override probe's assessment logic, which assumes every evidence item is poisoned. Against real, legitimately-high confidence justified by two real evidence items (with the poisoned one correctly excluded and flagged), it produced a false failure. Fixed to check whether the poisoned item was treated as legitimate, not whether confidence stayed low.
- The direct-injection probe's suspicion-detection used a fixed keyword list that expected "instruction embedded" and missed the model's own, equally correct "embedded instruction" phrasing, along with several other natural ways of saying the same thing. Broadened the list rather than making it order-sensitive.

Both were caught only by reading the real response text, not by trusting the automated pass/fail bit.

## Implementing this effectively: a checklist

1. **Define the probe taxonomy and severity scale before writing any probes.** The four categories above, each with at minimum a critical/high/medium severity band, so "one critical success fails the suite" has a real threshold to check against.
2. **Wire every probe to the real production call path.** If `rootCauseAgent.ts` changes its prompt structure, the probes should break loudly, not silently test a stale mock.
3. **Fail on any critical-severity success**, not an aggregate resistance percentage. A system that resists 18 of 23 attacks but loses to one critical prompt-injection case has failed, full stop.
4. **Version the probe set alongside the prompts it tests.** A prompt change without a corresponding probe re-run should be visible in CI, not discovered later.
5. **Log every probe run to the audit trail**, the same `correlationId`-threaded pattern from `docs/audit-trail-design.md`, so the evaluation history itself is reconstructable later, not just the production decisions it's meant to protect.
6. **Extend REQ-019/REQ-020, don't duplicate them.** The grounding and claim-verification checks already exist; adversarial probes should test whether deliberate pressure can defeat them, not reimplement citation checking from scratch.

## Closing point

CoreOps earns the trust it asks a human approver to extend only if the reasoning behind a recommendation has actually been attacked and held, not merely tested against inputs nobody was trying to break. The deterministic guardrails prove an approved action is safe to run. Adversarial evaluation is what would let CoreOps say, with evidence instead of confidence, that the recommendation a human is approving wasn't shaped by something hostile sitting in the evidence it read.
