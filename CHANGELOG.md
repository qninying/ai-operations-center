# Changelog

Milestones only. The full, per-change engineering log (every change with its verification evidence) is in [`docs/archive/PROGRESS-full.md`](docs/archive/PROGRESS-full.md).

## 2026-11 · Portfolio cleanup
- Repo root decluttered (build-process material in `docs/process/`, the Python MCP server in `tools/`), README rewritten, CI workflow for type checks and tests added.

## 2026-10 · Plug-in connectors, live reporting, 4.0/4 trust score
- Data sources became plug-in connectors behind one interface ([ADR-016](docs/ADR-016-plugin-connector-architecture.md)).
- SSRS report data live in production.
- Command Center published on GitHub Pages, with live system status from `/health/dependencies`.
- CI check that fails when the published repo inventory drifts from the code.
- Self-assessed trust scorecard reached 4.0/4 across identity, non-repudiation, provenance, accountability, control and transparency.

## 2026-09 / 10 · Production on Fly.io
- Containerized and deployed to [coreops.fly.dev](https://coreops.fly.dev) with a GitHub Actions deploy pipeline.
- Rolling deploys (blue-green was incompatible with the audit-trail volume), automatic rollback on a failed deploy, and paging on deploy failure.
- Incident drill: health check broken on purpose, caught by CI, rolled back and recovered in about 90 seconds ([write-up](docs/INCIDENT-DRILL-001.md)).
- Fixed live SQL Server connectivity (Node resolving through a dead IPv6 route).
- Trust and risk review findings closed: secret redaction in evidence, backup-approver config, audit reasoning, API budget.

## 2026-08 / 09 · Hardening and real execution
- Session-based auth ([ADR-003](docs/ADR-003-session-based-authentication.md)), TOTP MFA ([ADR-006](docs/ADR-006-totp-mfa.md)) and a second approver identity ([ADR-007](docs/ADR-007-second-approver-identity.md)).
- Durable, rotating audit trail with one correlation ID across every layer ([ADR-002](docs/ADR-002-audit-trail-correlation-id-unification.md), [ADR-005](docs/ADR-005-audit-trail-persistence.md)).
- Evidence-grounding and claim-verification checks on AI output ([ADR-008](docs/ADR-008-evidence-grounding-check.md), [ADR-009](docs/ADR-009-structured-claim-verification.md)).
- SQL remediation safety rules ([ADR-010](docs/ADR-010-sql-remediation-safety.md)) and two real execution paths: Docker service restart and Postgres blocking-query kill ([ADR-012](docs/ADR-012-real-docker-execution.md), [ADR-013](docs/ADR-013-real-postgres-remediation.md)).
- MCP over HTTP with rate limiting, roots containment ([ADR-014](docs/ADR-014-mcp-roots-containment-order.md)), progress and log notifications.
- Semantic triage cache on pgvector ([ADR-015](docs/ADR-015-triage-semantic-cache-pgvector.md)).
- Adversarial evaluation: prompt injection, jailbreak and leakage probes.

## 2026-08 · Core platform
- Walking skeleton and Command Center.
- Human approval required for every production change, with denials and decisions logged to an immutable audit trail.
- Claude-driven root-cause analysis grounded in evidence, with a differential of possible causes when confidence is low.
- Role-based Operations Console (React), real SQL Server DMV data, cloud data sources, continuous monitoring.
- Confidence-based escalation, operator notifications via ntfy, and rollback for low-risk actions.
