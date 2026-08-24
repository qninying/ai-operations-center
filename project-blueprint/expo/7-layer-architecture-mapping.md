# CoreOps: 7-Layer Reference Architecture Mapping

CoreOps is an AI Operations Dashboard for SQL Server, SSIS, SSRS, and Windows
servers — an intelligent command center that detects, diagnoses, and proposes
remediations for operational incidents, with every production-affecting action
gated behind a real human approval. This document maps CoreOps's actual,
implemented codebase (`ai-operations-center`) onto the standard 7-layer reference
architecture for AI systems, layer by layer: what each layer is responsible for,
which real files and technologies implement it, how it interacts with its
neighbors, and why that layer specifically matters for the system's governance
story.

Every component named below is a real module in this repo, not a conceptual
placeholder — this is what CoreOps actually is as of 2026-08-24, not an aspirational
target architecture.

---

## Layer 01 — Application & Interaction

**Purpose:** Where a human sees the system's current state and takes action on it.

**Components & technologies:**
- `dashboard.html` — a self-contained vanilla-JS operations dashboard, served
  directly by the backend, with a shared `apiFetch()` wrapper around every API
  call.
- A separate React 19 + Vite console (`frontend/`), served from the same backend
  process at `GET /console` and `GET /assets/*` (see Layer 06's infrastructure
  notes) — same-origin with the API, so session cookies work with no CORS
  configuration at all.
- `login.html` — the sign-in page every unauthenticated visit is redirected to.

**Interactions:** This layer talks to the backend exclusively over its HTTP API
(Layer 03's routes), never directly to Layer 04 (reasoning), Layer 05 (data
integration), or Layer 06 (infrastructure) — every request crosses the
Governance & Guardrail layer's session check first.

**Responsibilities:** Render real system state (live incidents, monitoring
status, pending approvals), collect a human's approve/reject decision, and fail
visibly rather than silently when something goes wrong — a `401` from any API
call redirects to `/login` instead of leaving a stale or broken widget on screen.

**Significance:** This is the layer a human operator actually trusts or
distrusts the system through. If it silently swallows an error, retries
invisibly, or shows stale data as current, every layer beneath it can be
working perfectly and the system still fails its actual job — giving a human
enough truthful information to make a good decision.

---

## Layer 02 — Governance & Guardrail

**Purpose:** Blocks any action that lacks real evidence, isn't an allowed
reversible type, or doesn't carry a genuine human approval — before an
execution path is even reachable.

**Components & technologies:**
- `remediationGuardrail.ts` — a pure, deterministic function: same input always
  produces the same allow/deny decision, with named violation codes
  (`NOT_HUMAN_APPROVED`, `PRODUCTION_WRITE_REQUIRES_APPROVAL`) rather than a
  bare boolean.
- `hitlQueue.ts` — the human-in-the-loop approval queue. Enforces that only the
  *assigned* approver may decide a given item (`UnauthorizedDeciderError`).
- `auth/` — `credentials.ts` (scrypt password hashing, constant-time
  comparison), `sessionStore.ts` (sliding-expiry sessions), `cookies.ts`
  (`HttpOnly` + `SameSite=Strict` cookies). This is what makes "the assigned
  approver" a real, verified identity instead of a trusted string.
- `rateLimiter.ts` — a fixed-window limiter protecting the login route (5
  attempts/60s) and every other route, so this layer's identity check can't be
  brute-forced or flooded.

**Interactions:** Sits directly between Layer 01 and Layer 03 — every route
except the login page and health check runs through `requireSession()` first.
Layer 03's orchestration logic calls into this layer's guardrail check before
ever reaching an execution path; this layer never calls back up into Layer 01
or forward into Layer 04/05/06 itself.

**Responsibilities:** Authenticate the human, authorize the specific action
they're requesting, and refuse anything that fails either check — deterministically,
with no exceptions carved out for convenience.

**Significance:** This is the layer the entire governance model depends on. Every
other layer can be fully autonomous — the reasoning layer can propose, the
orchestration layer can sequence, the data layer can be read live — but nothing
with a real production effect crosses this boundary without a verified human
saying yes. It's also the layer that most directly answers "who is accountable
if something goes wrong": the approver on record is the operator who actually
authenticated, not a name string nobody checked.

---

## Layer 03 — Orchestration

**Purpose:** Sequences the actual workflow — detection, reasoning, escalation,
notification — and holds the process-level state (is monitoring running right
now, what was the last cycle's result) that ties the other layers together.

**Components & technologies:**
- `monitoringService.ts` — runs detection cycles, hands results to the
  reasoning layer, and records outcomes to the audit trail (Layer 07).
- `escalationService.ts` — decides when a low-confidence result needs a human
  rather than an automated next step.
- `notificationService.ts` — delivers operator notifications (via ntfy.sh) when
  something needs attention.
- `reliability/circuitBreaker.ts` — the shared pattern every external call in
  this layer uses: after repeated upstream failures, stop calling and surface a
  clear error instead of hammering a dead dependency.
- `httpServer.ts` — the actual HTTP route table that ties Layer 01's requests to
  this layer's services, and to Layer 02's guardrail checks.

**Interactions:** Receives requests from Layer 01 (via Layer 02's gate), calls
into Layer 04 for reasoning, Layer 05 for live data, and Layer 07 to record
every step. This is the layer with the most fan-out — it's the hub, not a
pass-through.

**Responsibilities:** Every external call this layer makes has an explicit
timeout and a capped retry count — no unbounded waits, no infinite retry loops.
When an upstream dependency is genuinely down, the circuit breaker trips and the
system says so clearly rather than hanging.

**Significance:** This is where "the system behaves predictably under failure"
actually gets decided. An AI system that only works when every dependency is up
isn't operationally trustworthy — this layer is what makes a bad SQL Server
connection, a rate-limited API, or a slow notification service a contained,
visible failure instead of a cascading one.

---

## Layer 04 — Reasoning / Model

**Purpose:** Produces a root-cause explanation and a confidence score from the
evidence Layer 05 gathers — the one layer where an LLM actually reasons about
the system's state, rather than just moving data around.

**Components & technologies:**
- `rootCauseAgent.ts` — real Anthropic Claude API calls (Claude Sonnet 5), not
  canned or templated responses. Output is validated with zod schemas before
  it's trusted as structured data, not just accepted as free text.
- `recommendationService.ts` / `cloudRecommendationService.ts` — turn a
  reasoning result into a concrete, evidence-linked recommendation the
  governance layer can evaluate.

**Interactions:** Called by Layer 03 with evidence gathered from Layer 05, and
its output flows back to Layer 03 for escalation decisions and eventually to
Layer 02 as a proposed action awaiting approval. It never talks to Layer 01 or
Layer 06 directly.

**Responsibilities:** Reason from real evidence to a real explanation, attach an
honest confidence score, and let a low score trigger escalation rather than
presenting a guess as a settled answer — confidence below 60% auto-escalates
instead of quietly downgrading to "probably fine."

**Significance:** This is the layer with the most inherent uncertainty in the
whole system — an LLM's output is probabilistic, not deterministic, unlike every
layer around it. The system's design choice is explicit about that: this layer
is allowed to be uncertain, but it's never allowed to be the layer that decides
whether to act on that uncertainty. That decision belongs to Layer 02, with a
human behind it.

---

## Layer 05 — Data Integration / Tooling

**Purpose:** Exposes the real data layer (SQL Server, Blob Storage) to the rest
of the system safely — the boundary where untrusted external data first enters
the system and gets validated before anything downstream treats it as fact.

**Components & technologies:**
- The MCP Tool Gateway (`mcp-server/src/`) — `mcpServerFactory.ts` builds the
  shared tool/resource registrations (`read_sql_server_dmv`,
  `run_diagnostic_query`) used by **both** of its transports:
  - `index.ts` — stdio, local/dev-only, zero network exposure, trusted by
    process ancestry.
  - `httpMcpServer.ts` — the network-reachable StreamableHTTP transport
    (**ADR-001**, closed 2026-08-24), gated by a real bearer token
    (`auth/apiToken.ts`) and, as of today, its own rate limiter — so AI agents
    or an execution service running centrally can reach the same tools a local
    developer can, without either one trusting the other implicitly.
- `dmvLiveSource.ts` — live SQL Server DMV reads, honestly tagged `live` when
  they succeed.
- `cloudBlobSource.ts` — live Azure Blob Storage reads, same honesty rule.
- `dmvReader.ts` — falls back to fixture data when the live source is
  unavailable, and always reports which source actually answered.

**Interactions:** Called by Layer 03 (for monitoring cycles) and Layer 04's
supporting services (for evidence gathering); this layer talks directly to
Layer 06's real infrastructure, and is the only layer that does.

**Responsibilities:** Parameterized queries only — no untrusted value is ever
interpolated into SQL. Every row read from a live source is schema-validated
(zod) before it's trusted as evidence. Read-only, least-privilege credentials
only — this layer is structurally incapable of writing to a monitored system,
by design, not by convention.

**Significance:** This is the trust boundary between "data this system
controls" and "data an external system handed it." Every injection risk, every
malformed-upstream-response risk, and every credential-scope risk in the whole
architecture concentrates here. Getting this layer's validation and read-only
enforcement right is what makes every layer above it able to treat incoming
data as safe to reason about.

---

## Layer 06 — Data & Infrastructure

**Purpose:** The real systems of record — where data actually lives, and the
one process that serves everything else.

**Components & technologies:**
- Azure SQL Database — the monitored SQL Server instance's system of record.
- Azure Blob Storage — supporting operational data.
- `mcp-server`'s single Node.js process — serves the dashboard, the React
  console, the REST API, and (as a second, separate process) the network MCP
  transport. No reverse proxy, no container orchestration, no separate database
  tier for application state — a deliberate choice given this repo's current
  scale (see **ADR-004**, which decided to serve the built console from this
  same process rather than standing up new infrastructure that didn't exist
  yet).

**Interactions:** Only Layer 05 talks to the external systems of record
directly (SQL Server, Blob Storage). Every other layer's persistent state (the
audit trail, sessions, rate-limit counters, the HITL queue) lives inside this
same process's memory or local disk — not in Azure SQL, which is reserved for
the actual monitored system, not this tool's own bookkeeping.

**Responsibilities:** Stay up, stay reachable, and be honest when it can't be —
every response from this layer is tagged `live` or `fallback` rather than
silently substituting one for the other.

**Significance:** This is the layer every claim the system makes ultimately
rests on. If Layer 06 is quietly degraded (a slow database, an expired quota) and
every layer above it doesn't propagate that honestly, the whole system's
credibility collapses at once — this is why "live vs. fallback" tagging exists
as an explicit, visible signal rather than an internal implementation detail.

---

## Layer 07 — Observability & Audit

**Purpose:** Makes the system's behavior reconstructable after the fact — not
just "what is happening now" (Layer 01's job) but "what happened, when, and who
decided it."

**Components & technologies:**
- `guardrails/auditLog.ts` — immutable, idempotent-by-id audit entries covering
  decisions, actions, ABAC policy evaluations, HITL events, and system events.
  As of **ADR-005** (2026-08-24), this now **persists to an append-only JSONL
  file**, rehydrated at startup — a governance record that used to vanish on
  every restart now survives one, live-verified by killing the running server
  mid-session and confirming a prior approval decision was still retrievable
  afterward.
- `observability/logger.ts` — structured JSON logs (timestamp, level, service,
  event, context), one object per line, the same format the persisted audit log
  reuses.
- A single correlation ID threaded through every service call in a given
  workflow — `GET /api/audit?correlationId=` reconstructs a full incident from
  detection through approval as one connected trail, not scattered fragments.

**Interactions:** Every other layer writes into this one — Layer 02 records
every decision, Layer 03 records every monitoring cycle and escalation, Layer 05
implicitly feeds it through the services that call it. This layer never calls
back into any other layer; it's a sink, not a participant in the request path.

**Responsibilities:** Record every governance-relevant event exactly once (the
audit log is idempotent by id — a retried write is a safe no-op, not a
duplicate), never lose that record to a process restart, and make it queryable
by the one identifier (`correlationId`) that ties a whole incident together.

**Significance:** This is the layer that turns "we have a guardrail" into "we
can prove the guardrail worked, on this specific date, for this specific
decision, made by this specific person." Without a durable version of this
layer, every other layer's careful governance logic is only as trustworthy as
the last time someone happened to look at it live — which is exactly the gap
this repo closed on 2026-08-24.

---

## How the layers connect: the golden thread

The correlation ID is the one identifier that survives the whole trip: it's
generated when a monitoring cycle starts (Layer 03), attached to the reasoning
result (Layer 04), carried into the proposed action and its guardrail
evaluation (Layer 02), and recorded at every one of those steps by Layer 07 —
so a single `GET /api/audit?correlationId=` call reconstructs the entire
decision, from the first piece of evidence to the human who approved or
rejected it. That thread, not any individual layer, is what makes this
architecture's governance claim checkable rather than just asserted.
