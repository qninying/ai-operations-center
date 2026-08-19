# CoreOps AI Operations Dashboard — Stories

11 stories across 5 releases, walking-skeleton first:
the earliest release proves the thinnest end-to-end path including the trust
spine, and later releases stack features on top of something already working.

## Before the releases — start here

- **[STORY-000](stories/STORY-000.md)** — Build your Command Center

The first thing you build, on day one, before any part of the system itself. It is
the page you keep open for the rest of the programme and demo from. It belongs to no
release and fulfils none of your requirements, because it is the window onto your
system rather than a part of it.

## r0 · Initial Setup and Trust Spine — weeks 0–1

**Goal:** Establish the core system with audit and approval workflows.
**Done when you can show:** Show a production change requiring human approval and logging the decision.

- **[STORY-001](stories/STORY-001.md)** — Implement human approval workflow for production changes
- **[STORY-002](stories/STORY-002.md)** — Log all decisions and actions for audit purposes

## r1 · AI Analysis and Recommendations — weeks 1–2

**Goal:** Implement AI-driven diagnostics and recommendations with confidence scores.
**Done when you can show:** Demonstrate AI recommendations with confidence scores and evidence-backed reasoning.

- **[STORY-003](stories/STORY-003.md)** — Implement AI-driven diagnostics and recommendations _(waits on STORY-001, STORY-002)_
- **[STORY-004](stories/STORY-004.md)** — Gather additional diagnostics for low-confidence incidents _(waits on STORY-003)_

## r2 · User Interface and Role-based Dashboards — weeks 2–3

**Goal:** Develop role-based dashboards and operational summaries.
**Done when you can show:** Display role-based dashboards for DBAs and IT Managers.

- **[STORY-005](stories/STORY-005.md)** — Develop role-based dashboards for different user types _(waits on STORY-004)_

## r3 · Integration and Extensibility — weeks 3–4

**Goal:** Enable integration with SQL Server, SSIS, SSRS, Windows servers, and cloud services.
**Done when you can show:** Show integration with SQL Server and a cloud service using standardized connectors.

- **[STORY-006](stories/STORY-006.md)** — Enable SQL Server data access for AI recommendations _(waits on STORY-005)_
- **[STORY-007](stories/STORY-007.md)** — Enable cloud service data access for AI recommendations _(waits on STORY-005)_

## r4 · Advanced Monitoring and Incident Management — weeks 4–5

**Goal:** Enhance monitoring capabilities and incident management workflows.
**Done when you can show:** Demonstrate continuous monitoring and incident escalation based on confidence thresholds.

- **[STORY-008](stories/STORY-008.md)** — Enhance monitoring capabilities for continuous incident management _(waits on STORY-007)_
- **[STORY-009](stories/STORY-009.md)** — Implement incident escalation based on confidence thresholds _(waits on STORY-008)_
- **[STORY-010](stories/STORY-010.md)** — Notify operators of autonomous actions _(waits on STORY-009)_
- **[STORY-011](stories/STORY-011.md)** — Implement rollback capabilities for low-risk tasks _(waits on STORY-009)_
