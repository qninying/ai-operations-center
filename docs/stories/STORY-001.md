# STORY-001 — Implement human approval workflow for production changes

As an IT Operations Manager, I want production changes to require human approval, so that unauthorized changes are prevented.

**Release:** r0 · Initial Setup and Trust Spine (weeks 0–1)
**Owner:** IT Operations
**Blocked by:** nothing — you can start this now

## The requirement this satisfies

- **REQ-001** (Safety, must) — The system must require human approval for any action that changes a production environment.

## How to build it

Implement approval workflow using existing ITSM tools. Log decisions in the audit trail.

## Failure paths you must handle

- Approval request not sent
- Approval request denied
- Audit log failure

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a production change request, When the request is submitted, Then it must require human approval.
- [ ] Given a denied approval, When the request is resubmitted, Then it must still require approval.
- [ ] Trust: Every approval decision is logged for audit.

When every box above is ticked, stop and show the demo.
