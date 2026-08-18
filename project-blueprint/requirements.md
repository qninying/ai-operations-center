# Project DNA & Requirements

Traceability between platform requirements and the artifacts that satisfy them.
Each requirement has a status:

- **UNMAPPED** — requirement is defined but no producing task/artifact exists yet
- **PLANNED** — a producing task (design + validator + tests + acceptance criterion) exists
- **BUILT** — the producing task has shipped as running code, verified

## Acceptance Checklist (reviewer-verifiable)

- [ ] **R1 — Core action via Claude agent:** `guardrails/rootCauseAgent.test.ts` exists
      and contains a passing test asserting the returned explanation cites the input
      evidence IDs, plus a passing test asserting an insufficient-evidence input
      returns an explicit low-confidence result (not free text).
- [x] **R2 — SQL Server DMVs data source (read-only):** `mcp-server/src/dmvReader.ts`
      + the `read_sql_server_dmv` tool in `index.ts` return well-formed DMV-shaped
      rows, and `readOnlyGuard.test.ts` asserts no *unreviewed* write-capable SQL
      driver dependency and no write-statement keywords in `dmvReader.ts`,
      `dmvLiveSource.ts`, or `index.ts`. Full suite: `cd mcp-server && npm test`.
- [x] **R3 — Result shaping + substitutions:** `mcp-server/src/dmvLiveSource.ts`
      queries a real (parameterized) SQL Server connection, falling back to fixture
      data on failure; `mcp-server/src/dmvReader.ts` caps every response to 3 rows and
      tags it `source: "live" | "fallback"`, normalizes an empty-string filter, and
      attaches a friendly `message` + logs a `warn` event on zero-result outcomes.
      `dmvLiveSource.test.ts` includes a regression test proving a `databaseName`
      containing a SQL-injection payload is bound as a parameter, never spliced into
      query text; `dmvReader.test.ts` covers the empty-input/zero-result boundary
      cases and confirms the happy path stays silent (no message, no log).
- [x] **R5 — Retry + timeout on the upstream call:** `mcp-server/src/reliability/`
      (`withReliability.ts` + `circuitBreaker.ts`) wraps `queryLiveDmv()` with a 10s
      timeout, 3 retries with exponential backoff, and a circuit breaker that opens
      after 5 failures in a 60s window (30s cooldown, half-open trial). Directly
      tested in `circuitBreaker.test.ts` (7 cases, deterministic via an injectable
      clock) and exercised end-to-end in `dmvLiveSource.test.ts`. 30/30 tests pass:
      `cd mcp-server && npm test`.
- [x] **R4 — Guardrail: human-approved, evidence-based remediation:**
      `guardrails/remediationGuardrail.test.ts` (10 cases, including a denied-approval
      case distinct from no-decision-yet) and `guardrails/auditLog.test.ts` (13 cases,
      covering both decision and action logging, retrieval, immutability, and
      idempotency) pass under the wired test runner (`guardrails/package.json` +
      `guardrails/tsconfig.json`, vitest 4). `cd guardrails && npm test` → 23/23
      passed; `npx tsc --noEmit` also passes. See PROGRESS.md 2026-08-13 and
      2026-08-18 notes.

---

## R1 — Core action via Claude agent

**Status:** UNMAPPED

**Requirement:** The system identifies root causes of correlated incidents using
Claude, reasoning over live, read-only evidence gathered from the affected
platform (SQL Server, SSIS, SSRS, Windows Servers) — not a template response
and not a guess from telemetry alone.

**Producing task:** _(none yet — this row is what we're filling in this task)_

**What "identifies root causes using Claude" means (acceptance criterion):** A root-cause
result is valid only if it satisfies all three properties below:

1. **Evidence-grounded** — the Claude call includes actual read-only query
   results/telemetry from the affected system in its prompt context, not just a
   description of the alert.
2. **Attributed output** — the returned root-cause explanation references which
   evidence IDs it used, so a reviewer can check the claim against the data
   instead of trusting prose.
3. **Non-fabricated when evidence is insufficient** — if the available evidence
   doesn't support a confident root cause, the function returns an explicit
   low-confidence/no-root-cause result rather than inventing one.

R1 moves UNMAPPED → PLANNED once: a root-cause function implementing this contract
exists, its tests cover the evidence-grounded, attributed, and insufficient-evidence
cases, and this row points at both.

---

## R2 — SQL Server DMVs data source (read-only)

**Status:** PLANNED

**Requirement:** The platform can read live operational state from SQL Server via
Dynamic Management Views (DMVs) — currently-executing requests, blocking sessions,
wait stats — through a read-only path that is architecturally incapable of writing
to the monitored server, matching the MCP Tool Gateway's read path in
`architecture.md`.

**Producing task:** `mcp-server/src/dmvReader.ts` (validation + fixture fallback path)
+ `mcp-server/src/dmvReader.test.ts` (7 cases) + `mcp-server/src/readOnlyGuard.test.ts`
(4 cases: no unreviewed write-capable SQL driver in `package.json`, no SQL write
keywords in `dmvReader.ts`, `dmvLiveSource.ts`, or `index.ts`) + the
`read_sql_server_dmv` tool registration in `mcp-server/src/index.ts`. As of R3 (below),
`dmvReader.ts` also orchestrates a real SQL Server connection via
`mcp-server/src/dmvLiveSource.ts` rather than being fixture-only — see R3 for that
part of the story. Full suite (15 tests across `dmvReader`, `dmvLiveSource`, and
`readOnlyGuard`) passes under `npm test` (vitest 4).

**What "read-only DMV data source" means (acceptance criterion):** The data source is
valid only if it satisfies all three properties below:

1. **Well-formed** — the resource returns data shaped like a real DMV query result
   (typed rows matching the target DMV's actual columns), not an arbitrary blob.
   **Tested against the fixture shape.** The live query (R3) now derives
   `database_name` correctly via `DB_NAME(r.database_id)` rather than assuming it's a
   column, closing that specific gap — but the query itself has never run against a
   real SQL Server instance in this environment, so full column fidelity is still
   unconfirmed in practice, only by inspection of the query text.
2. **Read-only by construction** — the resource and any related tool have no code
   path capable of executing a write statement against SQL Server; this is a
   property of what the code *can* do, not a policy comment. **Tested** —
   `readOnlyGuard.test.ts` is an automated regression guard, not just a design claim.
3. **Contract-stable under a stub** — swapping the fixture data source for a live
   connection must not change the resource's URI, shape, or the tool's input/output
   schema. **Partially demonstrated:** R3 added the live path behind `readDmv()`
   without changing the MCP tool's URI or output schema — but `readDmv()`'s own
   signature *did* change (sync → async, added `source` field), because the original
   PLANNED note assumed a signature that turned out to be insufficient once fallback
   and result-tagging were designed. The one thing genuinely unproven is whether the
   live path works end-to-end — no real SQL Server has ever been reachable to
   confirm the query succeeds, only that it fails safely when unreachable.

R2 moves PLANNED → BUILT once: the live query in `dmvLiveSource.ts` has actually
succeeded against a real SQL Server instance at least once (not just "fails safely"),
and its returned columns are reconciled against that instance's real schema.

---

## R3 — Result shaping + substitutions

**Status:** PLANNED

**Requirement:** The core DMV read action is backed by a real SQL Server source, not
just fixture data — with results shaped for consumption (capped, most-relevant-first)
and every variable input safely substituted into the query (parameterized, never
string-concatenated), with a graceful, clearly-labeled fallback when the real source
is unavailable.

**Producing task:** `mcp-server/src/dmvLiveSource.ts` (real, parameterized SQL Server
query behind `queryLiveDmv()`; timeout/retry/circuit-breaker behavior moved to R5's
`reliability/` wrapper as of that requirement — see R5 for those specifics) +
`mcp-server/src/dmvReader.ts` (orchestrates live-then-fallback, caps every response to
3 rows, tags `source: "live" | "fallback"`, normalizes an empty-string filter, and
attaches a friendly `message` on zero-result outcomes) +
`mcp-server/src/observability/logger.ts` (minimal structured JSON logger, writes to
stderr — stdout is reserved for the stdio MCP protocol stream in `index.ts`) +
`mcp-server/src/dmvLiveSource.test.ts` (missing-config throw, retry-then-fail,
retry-then-succeed, and a dedicated SQL-injection regression test) + shaping/fallback
and empty-input/zero-result boundary cases in `dmvReader.test.ts`.

**What "result shaping + substitutions" means (acceptance criterion):** Valid only if
it satisfies all four properties below:

1. **Shaped** — output is capped to at most 3 rows regardless of source (enforced
   both at the SQL level via `TOP (3)` and defensively in the orchestrator via
   `.slice(0, 3)`, so a change to one doesn't silently remove the guarantee).
   **Tested** — `dmvReader.test.ts` asserts a 7-row mock live result is capped to 3.
2. **Substituted, not concatenated** — any variable input (`databaseName`) is bound as
   a SQL parameter; `dmvName` is only ever used as a lookup key into a fixed,
   hardcoded query map, never as SQL text. **Tested** — `dmvLiveSource.test.ts` passes
   a SQL-injection-shaped string as `databaseName` and asserts it was bound via
   `request.input(...)`, not present anywhere in the query text sent to `.query()`.
3. **Gracefully degraded, never silently** — on live-source failure (missing config,
   timeout, exhausted retries, open circuit), the caller gets fixture data instead of
   an error, but always tagged `source: "fallback"` so nothing downstream (including
   Claude) can mistake degraded data for real data. **Tested** — all three known
   failure types (`LiveSourceUnavailableError`, `UpstreamCallFailedError`,
   `CircuitOpenError` — the latter two added by R5) are asserted to trigger fallback
   with the correct tag; an *unrecognized* error type is asserted to propagate rather
   than being silently swallowed into a fallback.
4. **Empty input and zero-result handling — never silent** — an empty-string
   `databaseName` filter (almost certainly a caller mistake, not an intentional
   "match nothing") is normalized to "no filter"; a genuine zero-result outcome
   (whichever source served it) gets a friendly `message` field and a logged `warn`
   event (`dmv_zero_results` / `dmv_empty_filter_normalized`) rather than an
   unexplained empty array. **Tested** — boundary cases in `dmvReader.test.ts` cover
   both, plus a check that non-empty happy-path results stay silent (no message, no
   log), so this doesn't leak into normal responses.

R3 moves PLANNED → BUILT once: the live path has succeeded against a real SQL Server
instance at least once (same bar as R2 — they share this open item), proving the
shaping and substitution logic runs correctly against real data, not just mocks.

---

## R5 — Retry + timeout on the upstream call

**Status:** PLANNED

**Requirement:** Every upstream call is wrapped with a bounded timeout and capped
retries with backoff, and protected by a circuit breaker that stops calling a
sustained-failing upstream rather than continuing to hammer it.

**Producing task:** `mcp-server/src/reliability/circuitBreaker.ts` (generic state
machine: closed/open/half-open, injectable clock) + `circuitBreaker.test.ts` (7 cases:
stays closed below threshold, opens at threshold, sliding-window boundary, remaining
cooldown reporting, half-open transition, closes on successful trial, reopens
immediately on failed trial) + `mcp-server/src/reliability/withReliability.ts` (generic
timeout + exponential-backoff retry wrapper, composable with an optional
`CircuitBreaker`) + its application to `queryLiveDmv()` in `dmvLiveSource.ts` (10s
timeout, 3 retries, 500ms→4s backoff, 5-failure/60s-window/30s-cooldown breaker) +
`dmvLiveSource.test.ts`'s retry/circuit-breaker cases (using fake timers, since that
test exercises the wrapper through real `setTimeout`-based delays rather than the
directly-injectable clock `circuitBreaker.test.ts` uses).

**What "retry + timeout on the upstream call" means (acceptance criterion):** Valid
only if it satisfies all four properties below:

1. **Bounded timeout** — every attempt has an explicit timeout (10s); a hung upstream
   call cannot block forever. **Tested** — `withTimeout()` races the operation against
   a timer that rejects with `UpstreamTimeoutError`.
2. **Capped retries with backoff** — up to 3 retries (4 attempts total), exponential
   backoff (500ms base, ×2, capped at 4s) — not immediate/unbounded retrying, and not
   a fixed delay that hammers a struggling upstream at a constant rate. **Tested** —
   `dmvLiveSource.test.ts` asserts exactly 4 attempts before giving up.
3. **Circuit breaker after repeated failures** — 5 failures within a 60s window opens
   the circuit; further calls fail fast (no attempt made) until a 30s cooldown elapses,
   then exactly one half-open trial is allowed through. **Tested** directly
   (`circuitBreaker.test.ts`, deterministic) and indirectly through the real wrapper
   (`dmvLiveSource.test.ts`).
4. **Generic, not SQL-specific** — the reliability wrapper has no dependency on
   `mssql` or any DMV-specific type, so the next upstream call this project builds
   (the Claude-calling Root Cause Analysis Agent, R1) can reuse it directly. **True by
   construction** — `reliability/` imports nothing from `dmvLiveSource.ts` or
   `dmvFixtures.ts`; not independently tested since there's no second caller yet to
   prove reuse against. Revisit once R1 actually uses it.

R5 moves PLANNED → BUILT once: a second upstream call (most likely R1's Claude calls)
actually reuses `withReliability`/`CircuitBreaker` in production code, proving
property 4 for real rather than by inspection, and the live SQL Server path (shared
open item with R2/R3) has succeeded at least once end-to-end.

---

## R4 — Guardrail: Human-approved, evidence-based remediation

**Status:** BUILT

**Requirement:** The platform continuously detects, correlates, and explains operational
incidents across enterprise data systems. Every AI recommendation is evidence-based,
auditable, and routed through human approval before executing any corrective action.
The system provides actionable remediation, business impact analysis, complete audit
trails, and reduces mean time to detection (MTTD) and mean time to resolution (MTTR)
without allowing autonomous production changes.

**Producing task:** `guardrails/remediationGuardrail.ts` (validator; `approval` is a
discriminated `{ status: "approved" | "denied", decidedBy, decidedAt, reason? } | null`
decision, not a bare presence flag, as of STORY-001) +
`guardrails/remediationGuardrail.test.ts` (10 cases: happy path, one per violation
type, a denied-approval case distinct from no-decision-yet, a resubmitted-denial
case, production-write-protected boundary reject/allow, simultaneous violations,
purity) + `guardrails/auditLog.ts` (STORY-001 criterion 3 + STORY-002/REQ-005:
records both approve/deny decisions and guardrail-evaluated actions, retrievable
by ID, frozen/immutable on write, idempotent on repeat) + `guardrails/auditLog.test.ts`
(13 cases) + `guardrails/package.json` / `guardrails/tsconfig.json` (vitest 4 test
runner, wired 2026-08-13). `cd guardrails && npm test` → 23/23 passing;
`npx tsc --noEmit` clean.

**What "safe" means (acceptance criterion):** A remediation action is safe only if it
satisfies all four properties below. The guardrail validator enforces this as a pure,
deterministic check — `checkRemediationGuardrail(action) -> { allowed, violations }` —
run before any execution path is reachable:

1. **Evidence-linked** — the recommendation cites the specific incident evidence
   (metric/log/event IDs) it's based on; not a bare assertion.
2. **Human-approved** — it carries an explicit approval record (who, when) before
   execution; no approval, no execution.
3. **Non-autonomous / scoped** — the action type is on an allowed list of reversible,
   pre-approved remediation classes (e.g., restart service, clear queue) — never a
   raw/arbitrary command, and never against a system marked production-write-protected
   without approval.
4. **Audit-complete** — every step (detection → recommendation → approval/rejection →
   execution outcome) is recorded with a timestamp and correlation ID, so the trail is
   reconstructable end-to-end.

R4 moved UNMAPPED → PLANNED on 2026-08-07 once the validator and its tests existed
(see PROGRESS.md). R4 moved PLANNED → BUILT on 2026-08-13 once a test runner was
wired in and the 8-case suite was confirmed passing (`cd guardrails && npm test`),
per the bar stated in the Producing task line above. On 2026-08-18, STORY-001
(REQ-001) added an approval-decision audit log, then STORY-002 (REQ-005) that same
day generalized it into `guardrails/auditLog.ts`, extending property 4 to cover
both decisions *and* actions — every approve/deny decision and every
guardrail-evaluated action is logged, retrievable by ID, timestamped, immutable,
and idempotent. What's still not built: the *detection* and *recommendation* legs
of the full trail (detection → recommendation → approval → execution outcome),
because no detection/recommendation subsystem exists yet — that's R1, still
UNMAPPED. Property 4 is now closed for everything downstream of a proposed action;
it isn't closed end-to-end until R1 exists to log the upstream half.
