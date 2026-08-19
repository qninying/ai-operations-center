# STORY-006 — Enable SQL Server data access for AI recommendations

As a system, I want to access data from SQL Server, so that I can provide AI-driven recommendations to users.

**Release:** r3 · Integration and Extensibility (weeks 3–4)
**Owner:** System
**Blocked by:** STORY-005

## The requirement this satisfies

- **REQ-007** (Constraint, must) — The system must support integration with SQL Server, SSIS, SSRS, and Windows servers.
- **REQ-013** (Functional, must) — The system must provide explainable AI recommendations for all users.

## How to build it

Utilize standardized connectors to access SQL Server data for AI processing. Ensure data is logged for audit trails.

## Failure paths you must handle

- SQL Server connection failure
- Data retrieval timeout
- Invalid data format

## Acceptance — your stop condition

Tick each box as it genuinely passes. This file is yours — the platform reads
the same criteria out of `.colaberry/progress.json`, which Claude Code keeps in
step (see the managed block in CLAUDE.md). Ticking something you have not
actually met only misleads you.

- [ ] Given the system is connected to SQL Server, when a user requests a recommendation, then the system provides an AI-driven recommendation using SQL Server data.
- [ ] Given the system is unable to connect to SQL Server, when a user requests a recommendation, then the system notifies the user of the connectivity issue.
- [ ] Trust: All data access attempts are logged for audit purposes.

When every box above is ticked, stop and show the demo.
