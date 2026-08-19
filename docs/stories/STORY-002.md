# STORY-002 — Log all decisions and actions for audit purposes

As a Compliance Officer, I want all decisions and actions logged, so that I can audit them later.

**Release:** r0 · Initial Setup and Trust Spine (weeks 0–1)
**Owner:** Compliance
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-005** (Safety, must) — The system must log every decision and action for audit purposes.

## How to build it

Use a secure logging service to store audit logs with timestamps.

## Failure paths you must handle

- Log entry missing
- Log entry incorrect
- Log retrieval failure

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given an action is taken, When it is logged, Then it must be retrievable in the audit log.
- [ ] Given a decision is made, When it is logged, Then it must include the decision maker.
- [ ] Trust: Every log entry is timestamped and immutable.

When every box above is ticked, stop and show the demo.
