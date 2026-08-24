# STORY-005 — Develop role-based dashboards for different user types

As an IT Manager, I want a dashboard tailored to my role, so that I can quickly access relevant information.

**Release:** r2 · User Interface and Role-based Dashboards (weeks 2–3)
**Owner:** IT Manager
**Blocked by:** STORY-004

## The requirement this satisfies

- **REQ-006** (Functional, must) — The system must provide role-based dashboards for different user types.
- **REQ-009** (Functional, must) — The system must provide operational summaries for IT Managers and Engineering Leaders.

## How to build it

Design and implement dashboards using a UI framework that supports role-based views.

## Failure paths you must handle

- Dashboard not loading
- Incorrect role information
- Access log failure

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given a user role, When accessing the dashboard, Then it must display role-specific information.
- [ ] Given an IT Manager, When viewing the dashboard, Then it must show operational summaries.
- [ ] Trust: Dashboard access is logged by user role.

When every box above is ticked, stop and show the demo.
