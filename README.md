# AIOps — AI Operations Center

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

## What's built and tested

| Path | What it is |
|---|---|
| [`mcp-server/`](mcp-server/) | A real MCP server (official `@modelcontextprotocol/sdk`) over stdio and HTTP, exposing a read-only `read_sql_server_dmv` tool — parameterized queries, honest fixture-fallback when no live SQL Server is connected, a live dashboard at `/`. |
| [`mcp-server/src/reliability/`](mcp-server/src/reliability/) | A generic, reusable timeout + capped-retry-with-backoff wrapper and circuit breaker, wired around every upstream call. |
| [`guardrails/`](guardrails/) | `checkRemediationGuardrail()` — the structural rule that no remediation can execute without evidence, an allowed action type, and explicit human approval. |
| [`project-blueprint/requirements.md`](project-blueprint/requirements.md) | Per-requirement traceability (UNMAPPED / PLANNED / BUILT) with a reviewer-verifiable acceptance checklist — every claim points at a real test. |

30 tests, run with `cd mcp-server && npm test`.

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
tracks exactly what's real vs. planned, with a test a reviewer can run for every
claim — nothing is marked done without one.
