# STORY-009 — Implement incident escalation based on confidence thresholds

As an Infrastructure Engineer, I want incidents escalated based on confidence, so that I can prioritize responses.

**Release:** r4 · Advanced Monitoring and Incident Management (weeks 4–5)
**Owner:** Infrastructure Engineer
**Blocked by:** STORY-008

## The requirement this satisfies

- **REQ-011** (Functional, must) — The system must escalate incidents to a human when confidence is below 60%.

## How to build it

Configure incident management tools to escalate incidents based on confidence thresholds and log all escalations.

## Failure paths you must handle

- Escalation not triggered
- Incorrect confidence score
- Escalation log failure

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given an incident with low confidence, When escalated, Then it must notify a human operator.
- [ ] Given an escalation, When it occurs, Then it must be logged with the confidence score.
- [ ] Trust: All escalations are logged with timestamps.

When every box above is ticked, stop and show the demo.
