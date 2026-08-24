# STORY-004 — Gather additional diagnostics for low-confidence incidents

As a DevOps Engineer, I want additional diagnostics for low-confidence incidents, so that I can make informed decisions.

**Release:** r1 · AI Analysis and Recommendations (weeks 1–2)
**Owner:** DevOps
**Blocked by:** STORY-003

## The requirement this satisfies

- **REQ-010** (Functional, must) — The system must gather additional diagnostics when confidence is below 80%.

## How to build it

Implement diagnostic gathering tools to collect additional data for low-confidence incidents.

## Failure paths you must handle

- Diagnostics not gathered
- Incorrect diagnostics presented
- Diagnostics log failure

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given an incident with low confidence, When additional diagnostics are gathered, Then they must be presented to the user.
- [ ] Given multiple diagnostics, When they are presented, Then they must include possible causes.
- [ ] Trust: All diagnostics gathering is logged.

When every box above is ticked, stop and show the demo.
