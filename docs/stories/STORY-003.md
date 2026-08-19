# STORY-003 — Implement AI-driven diagnostics and recommendations

As a DBA, I want AI to diagnose issues and recommend actions, so that I can resolve incidents faster.

**Release:** r1 · AI Analysis and Recommendations (weeks 1–2)
**Owner:** DBA
**Blocked by:** STORY-001, STORY-002

## The requirement this satisfies

- **REQ-002** (Functional, must) — The system must automatically detect, diagnose, correlate, and recommend actions without executing production changes.
- **REQ-003** (Functional, must) — The system must provide confidence scores for recommended actions.
- **REQ-004** (Functional, must) — The system must present evidence-backed reasoning for all recommendations.

## How to build it

Develop AI models to analyze incidents and generate recommendations with confidence scores.

## Failure paths you must handle

- AI fails to diagnose
- Recommendation lacks evidence
- Confidence score incorrect

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given an incident, When AI analyzes it, Then it must provide a recommendation with a confidence score.
- [ ] Given a recommendation, When it is viewed, Then it must include evidence-backed reasoning.
- [ ] Trust: All recommendations are logged with confidence scores.

When every box above is ticked, stop and show the demo.
