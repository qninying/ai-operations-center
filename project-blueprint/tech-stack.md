# Tech Stack Recommendation — AI Operations Center

Source: [`architecture.md`](architecture.md). Full multi-page knowledge base: [`stack/index.html`](stack/index.html).

---

## 1. Fit-Rating Key

| Icon | Meaning |
|---|---|
| 🟢 **Great fit** | Matches this project's size and needs. Pick it, move on. |
| 🟡 **Good fit** | Works, but there's a real caveat worth reading before you commit. |
| 🔴 **Consider carefully** | Where this plan is most likely to hurt you. Still the best available recommendation — the caution is about *fit to this project's scale*, not quality of the technology. |
| — | Not a technology decision (existing infrastructure, or a person). |

Ratings are graded against **this project's actual scale**: one enterprise's own infrastructure, an internal ops team, continuous but bounded telemetry volume, and a small build team whose deep expertise is SQL Server/SSIS/SSRS/Windows administration — not distributed systems or frontend engineering. A technology can be excellent in general and still be 🔴 here.

---

## 2. Headline: Where This Stack Is Most Likely to Break

**This stack's biggest risk isn't a wrong technology pick — it's an operational skill gap.** Two components (the Event Bus and, to a lesser extent, the hosting layer implied by the data flow) require real distributed-systems operating experience — keeping a message broker or a container platform healthy under load — landing on a team whose proven depth is SQL Server, SSIS, SSRS, and Windows Server administration, not stream-processing or Kubernetes operations. Everything else in this stack is either PostgreSQL (one database technology, reused five times, that the team needs regardless), Claude API calls (Anthropic runs that infrastructure, not you), or small, contained services with no meaningful lock-in. If this plan fails, it's more likely to fail at "the Event Bus fell over during an incident storm and nobody on the team knew how to bring it back" than at "the AI gave a bad answer."

---

## 3. Recommendations, Grouped

Two rows from the architecture's component list — **Monitored Enterprise Platforms** and **Human User** — are existing infrastructure and a person, not a technology this project picks. They're listed with no fit rating. A third group, **What the Data Flow Needs**, covers technology the data flow clearly requires that the component list never named outright (hosting, secrets, self-monitoring) — flagged separately so it's clear these came from reading between the lines, not from the architecture table.

### Things a person touches

| Component | Technology | Fit | Why | Undo cost |
|---|---|---|---|---|
| Operations Console | React | 🟡 | React is a widely-used toolkit (a "component-based" approach, meaning the screen is assembled from reusable building blocks) for a UI with different views per role. | Moderate — a frontend rewrite, contained to one layer |

> **Caveat — Operations Console:** given how Microsoft-centric everything else here is (SQL Server, SSIS, SSRS, Windows Server), a **Blazor** app (Microsoft's own web UI framework, using C# instead of JavaScript) would let the team lean on skills they likely already have. This is a genuine toss-up worth a real side-by-side before committing, not a settled call.

### Things you write (services and agents this project builds)

| Component | Technology | Fit | Why | Undo cost |
|---|---|---|---|---|
| Correlation Engine | Faust (Python stream processing) | 🟢 | Faust is a Python library (a reusable code toolkit) for grouping events that happened close together in time, in plain readable code — not a black-box AI decision. | Easy — one internal service |
| AI Agent Orchestrator | Claude Agent SDK | 🟢 | Anthropic's own toolkit for running a fixed sequence of Claude-calling steps in the same order every time, with state-tracking built in. | Moderate — orchestration logic tied to SDK conventions |
| Root Cause Analysis Agent | Claude Sonnet 5 | 🟢 | A strong-reasoning, mid-cost model — this agent runs on *every* incident, so cost adds up fast, but the reasoning still needs to be trustworthy. | Easy — a config-level model swap |
| Impact & Remediation Agent | Claude Opus 5 | 🟡 | Anthropic's most capable model, reserved for the one agent whose output — an actual script a human might approve for production — carries the highest cost if wrong. | Easy — a config-level model swap |
| Summary Generation Agent | Claude Haiku 4.5 | 🟢 | The fastest, cheapest current model — a good fit because this agent rewrites already-assembled facts into two summaries, a well-defined writing task, not open-ended reasoning. | Easy — a config-level model swap |
| MCP Tool Gateway | Model Context Protocol (MCP) servers | 🟢 | MCP is an open standard (a public specification, not one vendor's product) built specifically for giving an AI agent a permissioned way to reach outside systems — the read/write split is enforced by the protocol itself. | Moderate — the standard is portable; the specific gateway build isn't |
| Approval Workflow Service | PostgreSQL status column + existing Event Bus | 🟢 | Tracking "pending / approved / rejected" as one column on an existing table, using infrastructure already being built, instead of a whole new workflow-engine product. | Easy — a data-model tweak |
| Execution Service | PowerShell 7 (Constrained Language Mode) | 🟢 | A real PowerShell security feature that blocks a script from doing anything beyond a pre-approved set of actions — matching this component's exact job. | Hard — entangled with the system's core write-path security guarantee |

> **Caveat — Impact & Remediation Agent:** running the most expensive model on every incident (not just high-risk ones) is a real cost tradeoff worth pricing out, not an obvious win.

### Things you store

| Component | Technology | Fit | Why | Undo cost |
|---|---|---|---|---|
| Telemetry Store | TimescaleDB | 🟢 | A PostgreSQL add-on (a plug-in that teaches an existing database new tricks) for efficient "what happened in the last hour" queries — reuses skills the team needs anyway. | Moderate — time-series query patterns would need rewriting |
| Incident Store | PostgreSQL | 🟢 | A mature relational database (data in related tables) with ACID guarantees (a saved record is never left half-written, even mid-crash) — exactly what a record needs to survive detection through approval to execution. | Hard — the system's central record; most services touch it |
| Service Dependency Map | PostgreSQL | 🟢 | Same database as the Incident Store, so the team maintains one system, not two, for hand-maintained reference data. | Easy — low query complexity |
| Audit Log Store | PostgreSQL with append-only triggers | 🟢 | Database triggers (small automatic actions on every write) block any UPDATE or DELETE at the database level, so the audit trail can't be quietly altered even by a bug elsewhere. | Hard — audit history has compliance weight once real incidents are recorded |

### Things you depend on (off-the-shelf infrastructure and external services)

| Component | Technology | Fit | Why | Undo cost |
|---|---|---|---|---|
| Telemetry Collectors | Telegraf | 🟢 | A free, actively-maintained agent (a small program that runs continuously and reports data) that already knows how to poll SQL Server and Windows counters. | Easy — only produces events in a known format |
| Event Bus | Apache Kafka | 🔴 | A durable message log (it keeps a replayable history of every event, not just the latest) — the industry standard for high-volume, fan-out streams like continuous telemetry. | Hard — the architectural backbone nearly every component touches |
| Claude (Anthropic API) | Anthropic Claude API | 🟢 | The reasoning engine the project idea names directly, used at three cost/capability tiers depending on each agent's job. | Moderate — agents are built around Claude's API shape; MCP layer stays provider-agnostic |

> **Caveat — Event Bus:** running Kafka well takes real distributed-systems operational skill — a genuine gap for a team whose expertise is SQL Server and Windows, not stream-processing infrastructure. **Azure Service Bus** (a managed queue, meaning Microsoft runs the servers for you) is worth comparing if the team is already Azure-based — lower operational burden, though a weaker fit for Kafka's specific "replay history" strength.

### What the data flow needs (not named in the component list)

The architecture's own deployment and security notes imply three more technology decisions that the component table never spelled out as a row.

| Need | Technology | Fit | Why | Undo cost |
|---|---|---|---|---|
| Hosting / container orchestration | Kubernetes | 🟡 | A system for running many small services (containers, meaning each service is packaged to run identically anywhere) that scales the ones that need it — the architecture's deployment notes call for exactly this ("scaled independently since telemetry volume, correlation load, and AI agent concurrency all grow at different rates"). | Hard — a re-platforming project if changed later |
| Secrets management | Azure Key Vault | 🟢 | A locked vault that hands out passwords and API keys to services at runtime, so service accounts and the Anthropic API key never sit in a config file — required directly by this repo's own security rules. | Moderate — services' secret-fetching code would need to change |
| Self-monitoring for the Ops Center's own infrastructure | Grafana + Loki | 🟡 | Monitoring for the Ops Center's *own* health (is the Correlation Engine keeping up, is an agent timing out) — a different concern from the Telemetry Store, which watches the platforms being managed. | Easy — sits alongside the architecture, not inside its data flow |

> **Caveat — Kubernetes:** real operational overhead for a team that doesn't already run it. A managed offering (Azure Kubernetes Service, where Microsoft operates the control plane) meaningfully lowers that burden and fits the Microsoft-centric environment already in play. A simpler fixed set of VMs is reasonable for an early Phase 1–2 build but won't hold up once Phase 6 needs independently-scaled AI agent concurrency.
>
> **Caveat — Self-monitoring:** the architecture explicitly calls this "not designed in diagram-level detail" — treat it as a real Phase 6+ build item, not an afterthought. A monitoring system that can't tell you it's unhealthy is its own kind of incident.

### Not a technology decision

| Component | Note |
|---|---|
| Monitored Enterprise Platforms | The existing SQL Server, SSIS, SSRS, and Windows Server environment already in production. |
| Human User | The engineer, approver, or executive using the console. |

**Summary:** 21 rows total — 19 technology decisions, 2 not applicable. Fit breakdown: 🟢 **14** · 🟡 **4** · 🔴 **1**.

**Least confident calls:** the **Event Bus** (Kafka vs. Azure Service Bus is a real, close call, not a formality — hence 🔴), the **Operations Console** (React vs. Blazor is a genuine toss-up given the team's likely .NET background), and **hosting** (whether Kubernetes is justified from day one or is over-engineering until Phase 6's independent-scaling need actually arrives).

---

## 4. Learn-More Prompts

Copy any of these into a new conversation to go deeper — each names this project by name so the answer is about your system, not a textbook.

| Technology | Prompt |
|---|---|
| React | "Explain React to me like I'm new to frontend frameworks, using my AI Operations Center project's Operations Console as the example — and compare it to Blazor for my team." |
| Faust | "Explain Faust to me like I'm new to stream processing, using my AI Operations Center project's Correlation Engine as the example." |
| Claude Agent SDK | "Explain the Claude Agent SDK to me like I'm new to AI agent frameworks, using my AI Operations Center project's Orchestrator as the example." |
| Claude Sonnet 5 | "Explain Claude Sonnet 5 to me like I'm new to choosing AI models, using my AI Operations Center project's Root Cause Analysis Agent as the example." |
| Claude Opus 5 | "Explain Claude Opus 5 to me like I'm new to choosing AI models, using my AI Operations Center project's Impact & Remediation Agent as the example, and help me think through the cost tradeoff." |
| Claude Haiku 4.5 | "Explain Claude Haiku 4.5 to me like I'm new to choosing AI models, using my AI Operations Center project's Summary Generation Agent as the example." |
| Model Context Protocol | "Explain the Model Context Protocol (MCP) to me like I'm new to AI tool integrations, using my AI Operations Center project's MCP Tool Gateway as the example." |
| Approval workflow pattern | "Explain how to build a simple approval workflow with a status column and a message queue, using my AI Operations Center project's Approval Workflow Service as the example." |
| PowerShell Constrained Language Mode | "Explain PowerShell Constrained Language Mode to me like I'm new to PowerShell security, using my AI Operations Center project's Execution Service as the example." |
| TimescaleDB | "Explain TimescaleDB to me like I'm new to time-series databases, using my AI Operations Center project's Telemetry Store as the example." |
| PostgreSQL | "Explain PostgreSQL to me like I'm new to databases, using my AI Operations Center project's Incident Store as the example. What tables would I actually have?" |
| PostgreSQL reference tables | "Explain how to design a PostgreSQL reference table to me like I'm new to databases, using my AI Operations Center project's Service Dependency Map as the example." |
| PostgreSQL append-only triggers | "Explain how PostgreSQL triggers can enforce an append-only log, using my AI Operations Center project's Audit Log Store as the example." |
| Telegraf | "Explain Telegraf to me like I'm new to monitoring agents, using my AI Operations Center project as the example." |
| Apache Kafka | "Explain Apache Kafka to me like I'm new to event streaming, using my AI Operations Center project as the example — and compare it to Azure Service Bus for my situation." |
| Anthropic Claude API | "Explain how the Anthropic Claude API works, using my AI Operations Center project's three different agents as the example." |
| Kubernetes | "Explain Kubernetes to me like I'm new to container orchestration, using my AI Operations Center project's central services as the example." |
| Azure Key Vault | "Explain Azure Key Vault to me like I'm new to secrets management, using my AI Operations Center project's service accounts and Anthropic API key as the example." |
| Grafana + Loki | "Explain Grafana and Loki to me like I'm new to observability tooling, using my AI Operations Center project's own infrastructure (not the platforms it monitors) as the example." |

---

## 5. What to Learn First, In Order

Foundational technologies before specialized ones; low-risk quick wins before the pieces that are hard to undo.

1. **PostgreSQL** — the one technology reused five times (Incident Store, Telemetry Store's foundation, Service Dependency Map, Audit Log Store). Learn this first; everything else assumes it.
2. **Containers (Docker basics)** — needed before Kubernetes makes sense.
3. **Apache Kafka** — the highest-risk, hardest-to-undo piece. Understand it early, deliberately, before it's load-bearing in production.
4. **Telegraf** — simple, low-risk, a quick early win.
5. **Anthropic Claude API basics** — model tiers, pricing, how a request/response works.
6. **Claude Agent SDK** — builds directly on Claude API knowledge.
7. **Model Context Protocol (MCP)** — builds on both Claude API and agent knowledge; this is what makes the read-only/write-gated safety guarantee real.
8. **React or Blazor** — settle the Operations Console question before building it twice.
9. **Kubernetes** — builds on Docker; tackle once the central services it will host are designed.
10. **PowerShell Constrained Language Mode** — narrow but critical; learn right before building the Execution Service, not before.
11. **Azure Key Vault** — wire in early, not as an afterthought — retrofitting secrets management after credentials are already hardcoded is painful.
12. **Grafana + Loki** — last on purpose; you need services running before you can watch them.

---

## 6. Alternatives Considered

| Component | Chosen | Runner-up | Why not chosen |
|---|---|---|---|
| Operations Console | React | Blazor | Blazor better matches the team's likely .NET background; React has the deeper industry-wide hiring pool and ecosystem. Genuinely close — see the caveat above. |
| Correlation Engine | Faust | Hand-rolled Kafka consumer | Faust already solves "read from Kafka reliably" safely; reinventing it by hand is easy to get subtly wrong. |
| AI Agent Orchestrator | Claude Agent SDK | Hand-rolled orchestration calling the Claude API directly | Lower lock-in, but rebuilds state-tracking and retry handling the SDK already provides. |
| Impact & Remediation Agent | Claude Opus 5 | Claude Sonnet 5 | Sonnet is cheaper and would work, but this agent's output (a script for production) is the single highest-stakes artifact in the system — worth paying for the strongest model here specifically. |
| MCP Tool Gateway | MCP servers | Custom REST API layer | A custom layer means reinventing permissioning and auditing MCP already standardizes. |
| Approval Workflow Service | Status column + Event Bus | Dedicated workflow engine (e.g. Camunda) | Over-engineering for "one decision per incident: approve or reject." |
| Telemetry Store | TimescaleDB | InfluxDB (purpose-built time-series DB) | Would add a second database technology to operate for a benefit this project's current scale doesn't clearly need. |
| Incident Store | PostgreSQL | MongoDB (document store) | Incident state has clear relationships (incident → telemetry refs → approval → execution outcome) that a relational database expresses more safely than a document blob. |
| Audit Log Store | PostgreSQL + triggers | Dedicated event-sourcing/ledger technology | Append-only triggers already give the tamper-resistance this project needs, without a new technology to operate. |
| Telemetry Collectors | Telegraf | Custom polling scripts per platform | Four hand-built pollers is four things to keep working; Telegraf's maintained plugins cover most of it already. |
| Event Bus | Apache Kafka | Azure Service Bus | Kafka is the stronger fit for high-volume replay-history streaming, but Azure Service Bus is managed and lowers the operational burden for a non-distributed-systems team — the strongest genuine alternative in this whole document. |
| Hosting | Kubernetes | Fixed VMs / Docker Compose | Simpler and fine for an early build, but doesn't hold up once Phase 6 needs AI agents to scale independently from everything else. |
| Secrets management | Azure Key Vault | HashiCorp Vault | Vault is cloud-neutral and strong, but Azure Key Vault fits an already Azure-adjacent, Windows Server/SQL Server environment more directly. |
| Self-monitoring | Grafana + Loki | Reusing TimescaleDB + a custom dashboard | Mixing the Ops Center's own operational metrics into the same store used to watch external platforms blurs a boundary worth keeping separate. |

---

## 7. How Hard Each Decision Is to Undo

| Undo cost | Components |
|---|---|
| **Easy** — swap it without touching anything else | Root Cause Agent model, Impact & Remediation Agent model, Summary Agent model, Correlation Engine library, Approval Workflow storage, Service Dependency Map storage, Telemetry Collectors, Self-monitoring stack |
| **Moderate** — a real but contained rewrite | Operations Console, AI Agent Orchestrator, MCP Tool Gateway, Telemetry Store, Claude API (provider swap), Secrets management |
| **Hard** — touches most of the system, or carries compliance weight | Execution Service, Incident Store, Audit Log Store, Event Bus, Hosting/Kubernetes |

The pattern: **which Claude model tier an agent calls is trivially reversible; which database holds the Incident Store, and which message bus carries every event, are not.** Spend the most deliberation on the "hard" row before committing — that's where a wrong call is expensive to walk back.

---

## 8. What This Document Does Not Tell You

- **Exact Claude API costs at your real incident volume.** Model-tier choices are reasoned qualitatively (this agent runs on every incident vs. only high-risk ones); a real token-cost estimate needs your actual expected incident rate.
- **Kubernetes cluster sizing, node counts, or a full deployment topology.** The architecture names the *pattern* (independently-scaled services); this document doesn't size the cluster.
- **A confirmed cloud provider.** Azure Key Vault and Azure Kubernetes Service are recommended because the monitored platforms (SQL Server, SSIS, SSRS, Windows Server) imply a Microsoft-adjacent environment — but that's an inference, not a confirmed decision. If the team is actually AWS- or on-prem-only, several rows in this document change.
- **Whether your specific team already knows any of these tools.** Ratings are graded against the *project's* scale and needs, not a specific team's current skills — except where explicitly flagged (React/Blazor, Kafka's operational skill gap).
- **Procurement or contract status.** Whether Anthropic API access is already provisioned org-wide, separate from any personal key, is called out as an assumption in `architecture.md` — this document doesn't resolve it.
- **Disaster recovery / high availability for the Ops Center's own infrastructure.** `architecture.md` explicitly flags this as not designed in diagram-level detail; this document doesn't fill that gap either — see the Self-monitoring caveat above.
