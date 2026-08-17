# AI Operations Center — MVP Plan (Week 1)

## The one question Week 1 answers

Can Claude take a hardcoded, already-correlated cross-service incident and
produce a root-cause explanation an engineer would actually trust enough to
act on — before any of the real infrastructure that would feed it real
evidence gets built?

## What you are building

- **Incident Store** — a minimal local PostgreSQL `incidents` table (id,
  raw_events, root_cause, technical_summary, executive_summary, status).
  Same technology as the full recommendation, just one local instance
  instead of the production data store.
- **Correlation Engine, stood in by hand** — a small script that inserts
  2–3 hardcoded, realistic telemetry events (a SQL Server blocking chain and
  the SSIS job it stalls, arriving seconds apart) as one already-grouped
  incident row. Stands in for Faust + Kafka without building either.
- **Root Cause Analysis Agent** — a script that calls **Claude Sonnet 5**
  (the model `tech-stack.md` picked for this exact agent) with the
  hardcoded event text and asks for a plain-English root cause. No live
  **MCP Tool Gateway** read access — simulated event details substitute for
  a real diagnostic query.
- **Summary Generation Agent** — a second script, using **Claude Haiku
  4.5** (again, the model already picked for this agent), that turns the
  root cause into one technical sentence and one executive-friendly
  sentence.
- **Operations Console** — the thinnest possible version: one static page
  (or a CLI command) that reads the single incident row from Postgres and
  displays the correlated events, the root cause, and both summaries. No
  login, no roles, no approval buttons.

## What you are NOT building, and why that's safe

| Cut | What it would prove | Why that isn't this week's question |
|---|---|---|
| Event Bus (Kafka) | The system survives high-volume, fan-out telemetry without falling over. | This week is about reasoning *quality*, not throughput. `tech-stack.md` already flags Kafka as the stack's biggest operational risk — no reason to take it on before it's load-bearing. |
| Telemetry Collectors (Telegraf) | Live polling against real SQL Server, SSIS, SSRS, and Windows Server actually works. | One hardcoded incident is enough to test whether Claude can reason over telemetry text; wiring real pollers is its own integration project. |
| Telemetry Store (TimescaleDB) | The Correlation Engine can compare a new event against real historical baselines. | This week's incident is fully hardcoded — there's no history yet to store or query against. |
| MCP Tool Gateway (live read path) | Claude can pull real diagnostic evidence from production systems safely. | Pre-written event text substitutes for a live query this week; the reasoning step can be tested without a real gateway in front of it. |
| Service Dependency Map + Impact & Remediation Agent | Claude can trace downstream business impact and draft a safe remediation script. | Per `architecture.md`, this is the single highest-stakes agent in the whole design. It's next week's riskiest question, deliberately deferred until root-cause reasoning is validated first. |
| Approval Workflow Service + Execution Service (the write path) | A human can safely approve and execute a real change on production. | Nothing should be able to touch a monitored server yet, and per the architecture's own core guarantee, that has to stay true regardless of how this week goes. |
| Audit Log Store | Every decision is traceable for compliance. | Nothing consequential enough to audit happens yet — there's no write path to log. |
| Role-based views + authentication in the Console | Engineers, approvers, and executives each see the right slice. | One unauthenticated read view is enough to judge whether the underlying reasoning is any good — that's the only question on the table. |
| Kubernetes / any container orchestration | Central services scale independently under real concurrency. | Hosting is explicitly a Phase 6 decision in `architecture.md`'s own build order, not a Week 1 one. |
| Azure Key Vault / secrets management | Service-account and API credentials are handled correctly at scale. | Week 1 has no real service-account credentials to protect — everything runs local and hardcoded. |
| Grafana + Loki (self-monitoring) | The Ops Center can tell you it's unhealthy. | Nothing is running continuously yet, so there's nothing to self-monitor. |

## The stack, cut down to Week 1

| Component | Full recommendation (`tech-stack.md`) | Week 1 |
|---|---|---|
| Incident Store | PostgreSQL | Same — PostgreSQL, one local instance |
| Correlation Engine | Faust + Kafka | A plain insert script — no stream processing, no message bus |
| AI Agent Orchestrator | Claude Agent SDK, state machine per incident | Skipped — two scripts called in sequence by hand |
| Root Cause Analysis Agent | Claude Sonnet 5 + MCP Tool Gateway | Claude Sonnet 5 direct API call, no gateway — same model, simulated evidence |
| Summary Generation Agent | Claude Haiku 4.5 | Same — Claude Haiku 4.5, direct API call |
| Operations Console | React, role-based views | One static HTML page or CLI, no framework, no roles |
| Everything else (Kafka, TimescaleDB, MCP servers, Approval Workflow, Execution Service, Audit Log, Kubernetes, Key Vault, Grafana+Loki) | — | Not built this week |

## Five days

- [ ] **Monday** — A local Postgres `incidents` table exists, and one
      hand-inserted row round-trips: insert it, query it, see it come back
      unchanged.
- [ ] **Tuesday** — Three hardcoded telemetry events, written as a SQL
      Server blocking chain and the SSIS job it stalls seconds later, sit
      in the `incidents` table as one pre-grouped incident row.
- [ ] **Wednesday** — A script sends that incident's raw event text to
      Claude Sonnet 5, and a specific, non-generic root-cause sentence —
      naming the actual causal link between the blocking chain and the
      SSIS failure — is written back to the row.
- [ ] **Thursday** — A second script sends the root cause to Claude Haiku
      4.5, and both a technical summary and an executive summary land in
      the row; a static page reads the row and shows the events, root
      cause, and both summaries together on one screen.
- [ ] **Friday** — A real person who did not build this — ideally someone
      with actual SQL Server/SSIS operations experience — reads the screen
      cold, with no root cause told to them in advance, and says whether
      they'd trust the explanation enough to act on it.

## What "it worked" looks like

At least 2 of 3 test reviewers, reading only the screen and given no
advance explanation, say the root-cause sentence matches what they'd have
suspected themselves, and none of the three flag it as "confidently
wrong."

## What "it didn't work" looks like

Claude produces a plausible-sounding but generic explanation that restates
the symptoms instead of diagnosing a cause — "the SSIS job failed after the
blocking chain appeared" instead of "the blocking chain held a lock the
SSIS job's UPDATE step needed, which is why the job stalled, not a
coincidence" — and a reviewer with real SQL Server ops experience calls it
out as something they would not trust in production.

## What you'll know on Friday, and what to do about it

| Outcome | What happened | Next move |
|---|---|---|
| **Pass** | 2–3 of 3 reviewers trust the explanation | Proceed to the next real infrastructure step: wire up the MCP Tool Gateway's read path so the Root Cause Analysis Agent works from live evidence instead of hardcoded text — the next riskiest assumption in the design. |
| **Partial** | 1 of 3 trusts it, or reviewers land on the right conclusion but find the reasoning shown unconvincing | Don't add infrastructure yet. Spend a second short cycle improving only the evidence and prompting shown to Claude — more realistic telemetry detail, a few real-incident examples — before touching MCP or Kafka. |
| **Fail** | 0 of 3 trust it, or explanations are consistently generic or wrong | Stop and reconsider the product. If Claude can't produce a trustworthy root cause from clean, hardcoded, favorable-case data, no amount of real-time infrastructure fixes that — the core value proposition needs rethinking before another line of code is written. |

## What Week 1 deliberately proves nothing about

- Whether live, MCP-mediated queries against real SQL Server/SSIS/SSRS
  return evidence Claude can actually use.
- Whether the Correlation Engine can group failures accurately at real
  cross-service volume and timing, not a hand-picked 3-event example.
- The cost or latency of the three-model pipeline at real incident volume.
- Whether the Impact & Remediation Agent — the highest-stakes agent in the
  design — can safely draft a script a human should approve.
- Whether executives, not just engineers, find the executive summary
  actually useful.
- The soundness of the approval workflow or the security of the write
  path — neither exists yet, on purpose.
- Whether this architecture holds up under an incident storm (many
  correlated incidents firing at once).

## Grounded in

- Architecture: `project-blueprint/architecture.md` — Correlation Engine,
  Incident Store, AI Agent Orchestrator, Root Cause Analysis Agent, Summary
  Generation Agent, Operations Console.
- Tech stack: `project-blueprint/tech-stack.md` — PostgreSQL, Claude Sonnet
  5, Claude Haiku 4.5, Claude Agent SDK.
