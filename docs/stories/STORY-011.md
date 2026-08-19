# STORY-011 — Implement rollback capabilities for low-risk tasks

As a system administrator, I want to be able to roll back low-risk tasks, so that I can ensure system stability and correct errors.

**Release:** r4 · Advanced Monitoring and Incident Management (weeks 4–5)
**Owner:** System Administrator
**Blocked by:** STORY-009

## The requirement this satisfies

- **REQ-015** (Safety, must) — The system must support rollback capabilities for low-risk, reversible tasks.

## How to build it

Develop rollback functionality for designated low-risk tasks. Ensure all rollback actions are logged.

## Failure paths you must handle

- Rollback failure due to task dependency
- Incorrect task identification for rollback
- Insufficient permissions for rollback

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a low-risk task is completed, when a rollback is requested, then the system successfully reverts the task.
- [ ] Given a rollback is requested for a non-reversible task, when the request is made, then the system denies the rollback request.
- [ ] Trust: All rollback actions are logged for audit purposes.

When every box above is ticked, stop and show the demo.
