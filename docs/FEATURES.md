# CoreOps features in detail

The README gives the one-line version of each feature. This page has the detail: where it lives in the code, how it was verified, and the decision record behind it. Each item has tests, and each was also checked against a running server, not only in unit tests.

## Governance and security

- **Session-based authentication** (`mcp-server/src/auth/`) gates every route: `scrypt` password hashing, `HttpOnly` + `SameSite=Strict` session cookies, and no raw credential ever reaches client-side JavaScript. Why sessions over JWT: [ADR-003](ADR-003-session-based-authentication.md).
- **TOTP MFA (RFC 6238)**, implemented with `node:crypto` and checked against the RFC's published test vectors, with drift tolerance and replay protection. Login requires TOTP, so every session is MFA-verified. This replaced a hardcoded `mfa: true` placeholder in the guardrail decision. See [ADR-006](ADR-006-totp-mfa.md).
- **Human-approval guardrail** (`guardrails/`) blocks any action that lacks evidence, is not an allowed reversible type, or has no approval. Only the assigned approver, verified by login, can decide it. An earlier version compared a hardcoded value against itself and could never fail; [ADR-003](ADR-003-session-based-authentication.md) records the fix.
- **Second approver identity** with its own credentials and MFA, closing a single-operator gap. The escalate-to-backup path was tested but unreachable from the live server, because the timeout check it depends on was never called. Verified with a full 15-minute wait: a second person decided an item after escalation, and the original approver was locked out with a `403`. See [ADR-007](ADR-007-second-approver-identity.md).
- **Rate limiting** on every HTTP surface, added after a trust audit confirmed it was missing.
- **MCP tool gateway over HTTP** (`mcp-server/src/httpMcpServer.ts`), protected by bearer-token auth. It gives AI agents read-only access to live diagnostics and no write privileges. See [ADR-001](ADR-001-mcp-transport-selection.md). MCP roots containment resolves the real filesystem path before comparing it with declared roots, which closes symlink and `../` escapes ([ADR-014](ADR-014-mcp-roots-containment-order.md)).
- **Configurable confidence thresholds** (insufficient evidence, differential gathering, human escalation) via environment variables, validated at startup. A malformed value fails fast instead of silently disabling the gate it controls (`mcp-server/src/confidenceThresholds.ts`).
- **Evidence grounding check** (`mcp-server/src/evidenceGroundingCheck.ts`) cross-checks every evidence ID an AI recommendation cites against the evidence it was given, and flags a fabricated citation or a diagnosis that cites nothing. Verified against a live Claude response (no false positive) and a deliberate break test. See [ADR-008](ADR-008-evidence-grounding-check.md).
- **Structured claim verification** goes one level deeper: the model cites the exact field and value behind each fact in its diagnosis, and each is compared exactly with the evidence. This catches a citation that exists but is misstated. See [ADR-009](ADR-009-structured-claim-verification.md). Neither check replaces human approval; they make the approver better informed.
- **Secret redaction** in evidence and logs (`mcp-server/src/evidenceRedaction.ts`), and adversarial evaluation probes for prompt injection, jailbreaks and leakage (`npm run eval:adversarial`, design in [adversarial-eval-design.md](adversarial-eval-design.md)).

## Audit trail

- **Immutable, idempotent records** of every decision and action, keyed by ID (`guardrails/auditLog.ts`), reconstructable end to end by correlation ID via `GET /api/audit?correlationId=`. See [ADR-002](ADR-002-audit-trail-correlation-id-unification.md).
- **Persisted to disk** as append-only JSONL. Verified by killing the server mid-session and confirming an earlier approval was still retrievable. See [ADR-005](ADR-005-audit-trail-persistence.md).
- **Size-based rotation, never deletion**: every entry stays queryable, split across numbered archive segments instead of one unbounded file. Verified against a copy of the production audit log (ADR-005 addendum).

## AI reasoning

- **Root Cause Analysis Agent** (`mcp-server/src/rootCauseAgent.ts`) calls Claude (`claude-sonnet-5`) over SQL Server DMV evidence. Output is validated with zod and attributed to evidence. It never fabricates a result when evidence is thin or the API call fails. Below 80% confidence it gathers a differential of possible causes instead of presenting one guess.
- **Cross-system correlation**: `GET /api/correlated-recommendation` (`mcp-server/src/correlatedRecommendationService.ts`) gathers SQL Server DMV and SSRS evidence together for one root-cause call. Correlation happens in the reasoning step, not through an invented join key (the two sources share no real key). If one source is down, the result is flagged `partialCorrelation` instead of quietly becoming single-source.
- **Source-aware remediation** with DBA-style safety rules, instead of one hardcoded action for every incident. See [ADR-010](ADR-010-sql-remediation-safety.md).
- **Semantic dedup for incident triage** (`mcp-server/src/triageSemanticCache.ts`): evidence is embedded locally (`@huggingface/transformers`, no paid API) and matched in a `pgvector` Postgres instance (`mcp-server/dev-vector-db/`), so a near-duplicate incident reuses a recent judgment instead of a fresh AI call. Optional at runtime (`PG_VECTOR_HOST` unset disables it). Verified against a running container: a near-duplicate matched at cosine distance 0.0047 and a different incident did not. See [ADR-015](ADR-015-triage-semantic-cache-pgvector.md).

## Reliability

- **Timeout, capped retry and circuit breaker** wrapper (`mcp-server/src/reliability/`) around every upstream call, SQL Server and the Anthropic API alike.
- **Live vs. fallback tagging**: an unreachable SQL Server shows as a visible notification, never a silent switch to fixture data. The same pattern covers SSRS execution monitoring (`mcp-server/src/ssrsReader.ts`, querying `ExecutionLog3`) and was verified against a running Apache Superset (`mcp-server/dev-superset/`).
- **Plug-in connectors**: each data source is one file plus one registry line; the incident feed, health report and Command Center all read the registry. Write paths stay hand-built and reviewed. See [ADR-016](ADR-016-plugin-connector-architecture.md).
- **Two execution paths that act on real systems**: a Docker service restart ([ADR-012](ADR-012-real-docker-execution.md)) and a Postgres blocking-query kill ([ADR-013](ADR-013-real-postgres-remediation.md)). Execution and confirmation are separate steps, so a restart is never reported as fixed until it is independently confirmed healthy.
- **Production demo targets**: with `DEMO_TARGET=prod` (`mcp-server/src/demoTargetConfig.ts`), the same detection and restart code points at `dev-postgres` and `dev-superset` running as their own Fly.io apps, reached over Fly's private network (`.flycast`, a routing detail found live, see ADR-012's second addendum) and restarted through the Fly Machines API (`mcp-server/src/flyMachinesExecutor.ts`). Verified with a full stop and restart cycle for both targets in production.

## Operations and deployment

- **Production on Fly.io** at [coreops.fly.dev](https://coreops.fly.dev), deployed by GitHub Actions (`.github/workflows/deploy.yml`). The step-by-step runbook is [DEPLOYMENT.md](DEPLOYMENT.md).
- **Rolling deploys**: blue-green was tried and turned out to be incompatible with the audit-trail volume (a Fly volume can only be attached to one machine). The tradeoff, a brief unavailability window per deploy, is documented.
- **Automatic rollback** on a failed deploy, and an operator page (ntfy) when a deploy fails.
- **Incident drill**: `GET /health` was broken on purpose, CI caught it, and a rollback restored service in about 90 seconds ([INCIDENT-DRILL-001](INCIDENT-DRILL-001.md)). A production SQL Server connectivity investigation is written up in [INCIDENT-002](INCIDENT-002-sql-server-connectivity.md).
- **`GET /health/dependencies`** reports each data source's mode (`live` or `fallback`) and last outcome, without a login.

## Interfaces

- **`mcp-server/src/dashboard.html`**: the main operations dashboard. Its `apiFetch()` wrapper sends an expired session to `/login` instead of failing silently.
- **Operations Console** (`frontend/`, React + Vite): role-based summaries, with a clear error state for an unrecognized role, served from `mcp-server` on the same origin ([ADR-004](ADR-004-console-serving-topology.md)). Visual theme: [ADR-011](ADR-011-moroccan-theme-system.md).
- **Command Center**: a static site that reports the repo's requirements, stories and inventory. See [COMMAND_CENTER.md](COMMAND_CENTER.md).
