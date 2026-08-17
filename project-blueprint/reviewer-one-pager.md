# CoreOps — Architecture Summary for Reviewers

*An intelligent, read-only-by-construction command center for SQL Server, SSIS, SSRS,
and Windows Server infrastructure. This page covers what's actually built and tested
in this repo — see `architecture.md` for the full target design and `requirements.md`
for per-requirement status and test evidence.*

## The problem

When a SQL Server job fails or an SSRS report comes back empty, someone has to
manually cross-reference job logs, blocking sessions, and downstream reports across
a dozen tools to figure out why — often hours after the fact. CoreOps continuously
watches these systems, correlates related failures, and uses Claude to explain root
cause from live evidence rather than a static runbook or a guess.

## The tools

The **MCP Tool Gateway** (`mcp-server/`) is a real, running MCP server built on the
official `@modelcontextprotocol/sdk`, exposed over both stdio (for Claude Code/Claude
Desktop) and a thin HTTP wrapper (for local verification and demos). Its
`read_sql_server_dmv` tool queries SQL Server's Dynamic Management Views
(`sys.dm_exec_requests`) through a fully parameterized query — no string
concatenation, ever — and returns structured JSON, capped to the 3 most relevant
rows. When no live SQL Server is configured or reachable, it degrades honestly to
fixture data, explicitly tagged `source: "fallback"` so nothing downstream — including
Claude — can mistake demo data for production data.

To actually see it running rather than reading about it: `cd mcp-server && npm run
http`, then open `http://localhost:8787/` — a small live dashboard shows the same
tool's real output as incident cards, plus a button that triggers the guardrail below
against a real proposed remediation. See `demo-script.md` for a guided walkthrough.

## The guardrail

One rule outranks everything else in this design: **the system can investigate and
recommend, but it can never act without a human's sign-off.** This isn't a policy
comment — it's `checkRemediationGuardrail()`, a pure, deterministic function every
proposed remediation must pass before an execution path is even reachable. It checks
four things: the action is linked to real incident evidence, it's on an allow-list of
reversible action types (never an arbitrary command), it carries an explicit human
approval record, and production-write-protected targets require that approval
without exception. A recommendation that's evidence-linked and correctly-typed but
missing approval still gets rejected — approval isn't a formality, it's the gate.

## The reliability measures

Every upstream call (currently the SQL Server query path) is wrapped in a generic,
upstream-agnostic reliability layer (`mcp-server/src/reliability/`), built to be
reused by the next upstream call this project adds (a Claude-calling agent):

- **10-second timeout** per attempt — no call can hang indefinitely.
- **3 capped retries** with exponential backoff (500ms → 1s → 2s), not immediate or
  unbounded retrying.
- **Circuit breaker** — opens after 5 failures in a 60-second window, fails fast for
  30 seconds, then allows exactly one half-open trial before deciding whether to
  close or reopen.
- **Graceful degradation, never silent** — every known failure mode (missing config,
  exhausted retries, open circuit) falls back to fixture data with an honest tag;
  empty inputs and zero-result outcomes get a friendly message and a structured
  `warn` log event, not an unexplained empty response.

## Status: honest, not polished

This is a **walking skeleton**, not a finished product. Every claim above is backed
by passing tests (30/30 as of this writing — `cd mcp-server && npm test`), but the
live SQL Server path has never actually run against a real instance in this
environment — only its "fails safely when unreachable" behavior is proven. That's the
explicit next milestone, tracked in `requirements.md` alongside every other
requirement's real status (UNMAPPED / PLANNED / BUILT) — nothing is marked done
without a test a reviewer can run themselves.
