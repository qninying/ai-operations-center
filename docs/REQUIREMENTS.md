# CoreOps AI Operations Dashboard — Requirements

An enterprise-grade AI Operations Dashboard for SQL Server, SSIS, SSRS, and Windows servers, providing intelligent command center capabilities with human approval for production changes.

This is the source of truth for what you are building. Your Claude Code prompts
point here. If you sharpen a requirement, edit it — your version is the real one.

| Kind | Meaning |
|---|---|
| Functional | something the system does |
| Safety | a guardrail, with a check that enforces it |
| Reliability | how it behaves when something fails |
| Constraint | a technology or vendor you must use — context, not a task |

## AI Analysis

### REQ-002 — Functional · must

The system must automatically detect, diagnose, correlate, and recommend actions without executing production changes.

Fulfilled by: STORY-003

### REQ-003 — Functional · must

The system must provide confidence scores for recommended actions.

Fulfilled by: STORY-003

### REQ-004 — Functional · must

The system must present evidence-backed reasoning for all recommendations.

Fulfilled by: STORY-003

### REQ-010 — Functional · must

The system must gather additional diagnostics when confidence is below 80%.

Fulfilled by: STORY-004

### REQ-011 — Functional · must

The system must escalate incidents to a human when confidence is below 60%.

Fulfilled by: STORY-009

### REQ-013 — Functional · must

The system must provide explainable AI recommendations for all users.

Fulfilled by: STORY-006, STORY-007

## Approval Workflow

### REQ-001 — Safety · must

The system must require human approval for any action that changes a production environment.

Fulfilled by: STORY-001

### REQ-015 — Safety · must

The system must support rollback capabilities for low-risk, reversible tasks.

Fulfilled by: STORY-011

## Audit Trail

### REQ-005 — Safety · must

The system must log every decision and action for audit purposes.

Fulfilled by: STORY-002

## Configuration

### REQ-014 — Functional · should

The system must allow configuration of confidence thresholds for actions.

_Not yet fulfilled by any story._

## Efficiency

### REQ-017 — Non-functional · should

The system must reduce manual incident correlation across systems by 50-70%.

_Not yet fulfilled by any story._

## Integration

### REQ-007 — Constraint

The system must support integration with SQL Server, SSIS, SSRS, and Windows servers.

Fulfilled by: STORY-006

### REQ-008 — Constraint

The system must support integration with cloud services and enterprise applications through standardized connectors.

Fulfilled by: STORY-007

### REQ-018 — Constraint

The system must provide a plug-in connector architecture for extensibility.

Context for the stories that use it — constraints do not get their own story.

## Monitoring

### REQ-016 — Functional · must

The system must provide continuous monitoring and AI-powered root cause analysis.

Fulfilled by: STORY-008

## Notification

### REQ-012 — Safety · must

The system must notify operators immediately of any autonomous actions taken.

Fulfilled by: STORY-010

## User Interface

### REQ-006 — Functional · must

The system must provide role-based dashboards for different user types.

Fulfilled by: STORY-005

### REQ-009 — Functional · must

The system must provide operational summaries for IT Managers and Engineering Leaders.

Fulfilled by: STORY-005
