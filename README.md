# CoreOps — AI Operations Center

An enterprise-grade AI Operations Center concept — an intelligent command center for
SQL Server, SSIS, SSRS, Windows Servers, and enterprise data platforms. It
continuously monitors operational telemetry, correlates failures across services,
uses Claude to identify root causes and downstream business impact, recommends safe
remediation, and presents both technical and executive-friendly incident summaries —
with a read-only monitoring layer and mandatory human approval before anything writes
to production.

This repo has two layers: a full **system design + planning artifact** (architecture,
tech stack, MVP plan, browsable knowledge base), and a **working walking skeleton** —
a real MCP server, a tested guardrail, and a live dashboard — built incrementally on
top of that design, one small, tested, reversible step at a time.

It also tracks two separate things, on purpose: `project-blueprint/requirements.md`
covers the MCP/guardrail work below (requirements R1–R5), while `.colaberry/plan.json`
+ `.colaberry/progress.json` track a larger, formally-scoped programme (11 stories
across 5 releases, 18 requirements) — see the Command Center for that one.

## Command Center

The programme's live status dashboard — 9 tabs (Overview, Outcomes, Users & Use Case,
Guardrails, Systems, Project Management, AI Agents, Knowledge Base, Data Model),
reading `.colaberry/plan.json` and `.colaberry/progress.json` at runtime. Nothing on
the page is hard-coded.

```bash
python3 -m http.server   # from the repo root; defaults to port 8000
```

Then open `http://localhost:8000/` — **must be served over HTTP, not opened as a
`file://` path**, or the browser can't resolve the page's relative data/asset paths.

Every tab has a **Sample / Real** toggle. Sample fills the page with clearly-labelled
made-up data so the finished shape is visible on day one. Real shows exactly what's
actually been built: 7 of 11 programme stories (STORY-000/001/002/003/004/005/006) with
test-backed criteria, sitting at `"submitted"` — the guardrails those stories back
(REQ-001/005) still show as not-yet-enforced on the Guardrails tab, because this
repo only flips a story to `"verified"` on an external reviewer/commit sign-off, not
a self-declaration. None of the four target systems are connected yet. That's not a
bug in the dashboard — it's the real state of an early-stage programme, and the
whole point of the "Trust" rule this page is built around: no tab shows a number, a
connection, or a result the project hasn't actually produced.

## See it running

```bash
cd mcp-server
npm install
npm run http
```

Then open `http://localhost:8787/` — a live dashboard showing real SQL Server DMV
incident data and a "Recommend Remediation" button that triggers the real guardrail,
live, in the browser. See [`project-blueprint/demo-script.md`](project-blueprint/demo-script.md)
for a guided walkthrough, or [`project-blueprint/reviewer-one-pager.md`](project-blueprint/reviewer-one-pager.md)
for a one-page technical summary.

For the role-based Operations Console (STORY-005), with `mcp-server`'s HTTP server
already running as above:

```bash
cd frontend
npm install
npm run dev
```

Then open `http://localhost:5173/?role=it-manager` — role-specific operational
summaries fetched from the real backend (dev-proxied to `:8787`, configured in
`frontend/vite.config.ts`). Any other role value shows an honest error, not a guess.

Or, to see the console served the way it would be in a real deployment (one origin,
no dev proxy, session cookies just work), build it and let `mcp-server` serve it
directly — the same way it already serves `dashboard.html`:

```bash
cd mcp-server
npm run build-console   # builds frontend/, output isn't committed
npm run http
```

Then open `http://localhost:8787/console?role=it-manager`. This is the actual
resolution to the "where does the built frontend reach the backend" question — no
proxy, no CORS, real login required (sign in at `/login` first if you land on the
"Sign in required" state).

## What's built and tested

| Path | What it is |
|---|---|
| [`mcp-server/`](mcp-server/) | A real MCP server (official `@modelcontextprotocol/sdk`) over stdio and HTTP, exposing a read-only `read_sql_server_dmv` tool — parameterized queries, honest fixture-fallback when no live SQL Server is connected, a live dashboard at `/`. The live path is now confirmed against a real Azure SQL Database, not fixture-only. |
| [`mcp-server/src/rootCauseAgent.ts`](mcp-server/src/rootCauseAgent.ts) | The Root Cause Analysis Agent — a real Claude Sonnet 5 (Anthropic API) call over real DMV evidence, zod-validated structured output, evidence-attributed, never fabricates a result when evidence is thin or the API call itself fails. |
| [`mcp-server/src/diagnosticsGatherer.ts`](mcp-server/src/diagnosticsGatherer.ts) | When the Root Cause Agent's confidence is below 80%, gathers a differential — several distinct possible causes over the same evidence, each attributed — instead of presenting one under-confident guess. |
| [`mcp-server/src/dashboardSummary.ts`](mcp-server/src/dashboardSummary.ts) + [`GET /api/dashboard/summary`](mcp-server/src/httpServer.ts) | Role-based dashboard data — an IT Manager gets real DMV data reshaped into operational counts (incidents, blocked sessions), not raw technical rows. An unrecognized role is rejected (400), never rendered wrong. Every access is logged by role. |
| [`mcp-server/src/recommendationService.ts`](mcp-server/src/recommendationService.ts) + [`GET /api/recommendation`](mcp-server/src/httpServer.ts) | Wires real SQL Server data into a real AI recommendation. Never falls back to fixture data and calls it real — an unreachable SQL Server is an honest notification, not a silent substitution. Verified against a real, live Azure SQL Database, including a genuine blocking scenario. |
| [`mcp-server/src/reliability/`](mcp-server/src/reliability/) | A generic, reusable timeout + capped-retry-with-backoff wrapper and circuit breaker, wired around every upstream call — SQL Server and the Anthropic API alike. |
| [`guardrails/`](guardrails/) | `checkRemediationGuardrail()` — the structural rule that no remediation can execute without evidence, an allowed action type, and an approved (not denied, not absent) human decision. `auditLog.ts` records every decision and action, retrievable by ID, timestamped, immutable, idempotent. |
| [`frontend/`](frontend/) | The Operations Console — Vite + React + TypeScript. `?role=it-manager` renders a real operational summary fetched from `mcp-server`'s API (dev-proxied, no CORS surface added to the backend); any other role, or a failed fetch, shows an honest error state instead of guessing. |
| [`project-blueprint/requirements.md`](project-blueprint/requirements.md) | Per-requirement traceability (UNMAPPED / PLANNED / BUILT) with a reviewer-verifiable acceptance checklist — every claim points at a real test. |

62 tests in `mcp-server/` (`cd mcp-server && npm test`), 23 in `guardrails/`
(`cd guardrails && npm test`), 5 in `frontend/` (`cd frontend && npm test`).

## The design + planning layer

| Path | What it is |
|---|---|
| [`project-blueprint/architecture.md`](project-blueprint/architecture.md) | The system architecture: the idea, 18 components (with the plain-English reason each one exists), a Mermaid flowchart, a data-flow walkthrough, a 6-phase build order, assumptions, and what the design deliberately doesn't cover. |
| [`project-blueprint/tech-stack.md`](project-blueprint/tech-stack.md) | One real, fit-rated technology recommendation per architecture component, plus alternatives considered and how hard each choice is to undo. |
| [`project-blueprint/mvp-plan.md`](project-blueprint/mvp-plan.md) | A scoped Week 1 MVP: the single question it answers, a day-by-day plan, and explicit pass/partial/fail criteria. |
| [`project-blueprint/index.html`](project-blueprint/index.html) + section pages | A multi-page, offline-capable knowledge-base site rendering all of the above, with offline search, inline-SVG illustrations, expandable Mermaid/Chart.js figures, dark/light theme, and print support. |
| [`project-blueprint/one-pager.pdf`](project-blueprint/one-pager.pdf) | A one-page business/stakeholder pitch summary. |
| [`project-blueprint/reviewer-one-pager.md`](project-blueprint/reviewer-one-pager.md) | A one-page *technical* summary for reviewers: problem, tools, guardrail, reliability measures. |
| [`project-blueprint/demo-script.md`](project-blueprint/demo-script.md) | A 90-second screencast script — every command in it verified against real output before being written down. |

## The core design guarantee

Exactly one component in the architecture — the Execution Service — can write
anything to a monitored server, and it can only act after a human explicitly approves
a pending remediation. Every collector, every AI agent, and every read path is
architecturally incapable of writing to production, not just policy-incapable. The
guardrail in `guardrails/` is the first real piece of that guarantee, enforced in
code and covered by tests — not just a design claim. See "The sentence that outranks
everything else" in `architecture.md` for the full reasoning.

## Status

This is a walking skeleton, not a finished product. `project-blueprint/requirements.md`
tracks the MCP/guardrail work (R1–R5), and `.colaberry/progress.json` tracks the
programme (STORY-000 through STORY-011) — both are honest about what's real vs.
planned, with a test or an in-browser check for every claim. Nothing is marked done
without one.
