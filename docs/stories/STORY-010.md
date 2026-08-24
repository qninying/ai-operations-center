# STORY-010 — Notify operators of autonomous actions

As an operator, I want to be notified immediately of any autonomous actions taken by the system, so that I can monitor and respond as needed.

**Release:** r4 · Advanced Monitoring and Incident Management (weeks 4–5)
**Owner:** System
**Blocked by:** STORY-009

## The requirement this satisfies

- **REQ-012** (Safety, must) — The system must notify operators immediately of any autonomous actions taken.

## How to build it

Implement notification service to alert operators of autonomous actions. Ensure logging of actions and notifications.

## Failure paths you must handle

- Notification service failure
- Operator contact information missing
- Network issues

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given an autonomous action is taken, when the action is completed, then the system immediately notifies the operators.
- [ ] Given an autonomous action is taken, when the notification fails, then the system retries the notification until successful.
- [ ] Trust: All autonomous actions and notifications are logged for audit purposes.

When every box above is ticked, stop and show the demo.
