/*
  BLUEPRINT is the single source of data for the whole knowledge base.
  Every page (index.html and every 0N-*.html) renders from this object via
  site.js. Nothing here is a property of `window` — other scripts must
  reference the bare identifier `BLUEPRINT`, not `window.BLUEPRINT`, because
  a top-level `const` does not attach itself to the global object.
*/
const BLUEPRINT = {

  meta: {
    title: "AI Operations Center",
    subtitle: "Enterprise command center for SQL Server, SSIS, SSRS, Windows Servers, and enterprise data platforms",
    generatedNote: "Generated from a one-paragraph project idea using the system-architect method: every component traces back to specific words in that paragraph.",
    techStackFile: "tech-stack.md"
  },

  idea: {
    paragraph: "Design an enterprise-grade AI Operations Center that serves as an intelligent command center for SQL Server, SSIS, SSRS, Windows servers, and enterprise data platforms. The system should continuously monitor operational telemetry, correlate failures across multiple services, identify root causes using Claude, assess downstream business impact, recommend safe remediation steps, generate diagnostic SQL or PowerShell scripts, and present both technical and executive-friendly incident summaries. The architecture must be secure, scalable, and production-ready, using AI agents, MCP tools, event-driven workflows, audit logging, human approval for high-risk actions, and a read-only monitoring layer.",
    keySentence: "...secure, scalable, and production-ready, using ... a read-only monitoring layer, ... and human approval for high-risk actions.",
    keySentenceExplain: "An Ops Center that watches production SQL Server, SSIS, SSRS, and Windows infrastructure only earns the right to exist if it cannot itself become the incident. Exactly one component in this system can write anything to a monitored server — the Execution Service — and it can only act after the Approval Workflow Service records a human's sign-off. Every collector, every AI agent, every read path is architecturally incapable of writing to production, not just policy-incapable.",
    requirements: [
      { phrase: "intelligent command center for SQL Server, SSIS, SSRS, Windows servers, and enterprise data platforms", drives: "the scope of every platform-facing component" },
      { phrase: "continuously monitor operational telemetry", drives: "Telemetry Collectors + Event Bus + Telemetry Store" },
      { phrase: "correlate failures across multiple services", drives: "Correlation Engine" },
      { phrase: "identify root causes using Claude", drives: "Root Cause Analysis Agent" },
      { phrase: "assess downstream business impact", drives: "Impact & Remediation Agent + Service Dependency Map" },
      { phrase: "recommend safe remediation steps", drives: "Impact & Remediation Agent's remediation plan" },
      { phrase: "generate diagnostic SQL or PowerShell scripts", drives: "the script attached to the remediation plan" },
      { phrase: "present both technical and executive-friendly incident summaries", drives: "Summary Generation Agent + dual-view Operations Console" },
      { phrase: "AI agents", drives: "AI Agent Orchestrator" },
      { phrase: "MCP tools", drives: "MCP Tool Gateway" },
      { phrase: "event-driven workflows", drives: "Event Bus" },
      { phrase: "audit logging", drives: "Audit Log Store" },
      { phrase: "human approval for high-risk actions", drives: "Approval Workflow Service + Execution Service" },
      { phrase: "a read-only monitoring layer", drives: "the read/write split enforced across Collectors, MCP Tool Gateway, and Execution Service" }
    ],
    inputs: ["SQL Server", "SSIS", "SSRS", "Windows Servers"],
    pipelineStages: [
      { label: "Monitor telemetry", agent: false },
      { label: "Correlate failures", agent: false },
      { label: "Identify root cause", agent: true },
      { label: "Assess impact", agent: true },
      { label: "Recommend remediation", agent: true },
      { label: "Present summary", agent: true }
    ],
    output: "One incident: root cause + business impact + remediation script + technical & executive summaries"
  },

  categories: [
    { id: "collector", label: "Read-only Collection", color: "var(--c-blue)" },
    { id: "infra",      label: "Event Infrastructure", color: "var(--c-slate)" },
    { id: "store",      label: "Data Store",            color: "var(--c-slate)" },
    { id: "service",    label: "Service",                color: "var(--c-teal)" },
    { id: "agent",      label: "AI Agent",                color: "var(--c-teal)" },
    { id: "frontend",   label: "Frontend",                color: "var(--c-info)" },
    { id: "external",   label: "External / Third Party",  color: "var(--c-amber)" },
    { id: "actor",      label: "Human Actor",              color: "var(--c-green)" }
  ],

  components: [
    { id: "collectors", name: "Telemetry Collectors", category: "collector",
      summary: "Continuously pulls job status, error logs, and performance counters from every SQL Server, SSIS, SSRS, and Windows Server instance being watched, without ever writing to them.",
      words: ["continuously monitor operational telemetry", "SQL Server, SSIS, SSRS, Windows servers", "read-only monitoring layer"],
      technology: "Telegraf" },
    { id: "bus", name: "Event Bus", category: "infra",
      summary: "Carries every telemetry event from the collectors to whatever needs to react to it, so a burst of failures across many servers doesn't overwhelm any single consumer.",
      words: ["event-driven workflows", "continuously monitor... across multiple services"],
      technology: "Apache Kafka" },
    { id: "telemetry-store", name: "Telemetry Store", category: "store",
      summary: "Keeps a rolling history of every metric and log line so the Correlation Engine and AI agents have a recent baseline to compare against, not just the current spike.",
      words: ["continuously monitor operational telemetry", "correlate failures"],
      technology: "TimescaleDB" },
    { id: "correlation", name: "Correlation Engine", category: "service",
      summary: "Groups near-simultaneous failures across different services into one incident instead of leaving operators to spot the pattern themselves.",
      words: ["correlate failures across multiple services"],
      technology: "Faust (Python stream processing) — deliberately not an LLM call, so grouping is deterministic and testable on day one" },
    { id: "incident-store", name: "Incident Store", category: "store",
      summary: "Holds the full lifecycle of an incident — telemetry references, root cause, impact, remediation, summaries, approval state — so nothing is lost between detection and closure.",
      words: ["correlate failures", "identify root causes", "assess... impact", "recommend... remediation"],
      technology: "PostgreSQL" },
    { id: "orchestrator", name: "AI Agent Orchestrator", category: "service",
      summary: "Runs the fixed sequence of AI agents against a new incident and passes each agent's output to the next, so root cause → impact → remediation → summaries happen in the same order every time.",
      words: ["using AI agents", "identify... assess... recommend... generate... present"],
      technology: "Claude Agent SDK, state-machine per incident" },
    { id: "rca-agent", name: "Root Cause Analysis Agent", category: "agent",
      summary: "Asks Claude to explain why the correlated failures happened, using live read-only queries against the affected systems as evidence instead of guessing from telemetry alone.",
      words: ["identify root causes using Claude"],
      technology: "Claude Sonnet 5 (Anthropic API) + MCP Tool Gateway (read path)" },
    { id: "impact-agent", name: "Impact & Remediation Agent", category: "agent",
      summary: "Looks up what the failing system feeds downstream, has Claude state the business impact in plain terms, and drafts a remediation plan with an actual diagnostic SQL or PowerShell script attached.",
      words: ["assess downstream business impact", "recommend safe remediation steps", "generate diagnostic SQL or PowerShell scripts"],
      technology: "Claude Opus 5 (Anthropic API) + Service Dependency Map" },
    { id: "summary-agent", name: "Summary Generation Agent", category: "agent",
      summary: "Turns the root cause, impact, and remediation plan into two versions of the same incident — one for engineers, one for executives — without a human rewriting either by hand.",
      words: ["present both technical and executive-friendly incident summaries"],
      technology: "Claude Haiku 4.5 (Anthropic API)" },
    { id: "mcp", name: "MCP Tool Gateway", category: "service",
      summary: "Gives every AI agent one permissioned way to query SQL Server, SSIS, SSRS, and Windows Servers — read-only by default, with a separate write path only the Execution Service may call, and only after approval.",
      words: ["MCP tools", "read-only monitoring layer"],
      technology: "Model Context Protocol (MCP) servers, least-privilege scoped service accounts" },
    { id: "dependency-map", name: "Service Dependency Map", category: "store",
      summary: "Records which SSIS jobs feed which SSRS reports feed which business processes, so the Impact & Remediation Agent reasons over something concrete instead of inventing an impact story.",
      words: ["assess downstream business impact"],
      technology: "PostgreSQL, ops-maintained" },
    { id: "approval", name: "Approval Workflow Service", category: "service",
      summary: "Holds any remediation flagged high-risk in a pending state until a human explicitly approves or rejects it, and refuses to let the Execution Service run anything unsigned.",
      words: ["human approval for high-risk actions"],
      technology: "PostgreSQL status column on the Incident Store + the existing Event Bus, plus a deterministic risk-classification policy table" },
    { id: "execution", name: "Execution Service", category: "service",
      summary: "Is the only component allowed to change anything on a target server, and only runs a script once the Approval Workflow Service confirms a human signed off.",
      words: ["recommend safe remediation steps", "human approval for high-risk actions"],
      technology: "PowerShell 7 (Constrained Language Mode) invoking the MCP Tool Gateway's write path; idempotent per run" },
    { id: "audit-log", name: "Audit Log Store", category: "store",
      summary: "Appends an immutable record of every telemetry event, tool call, agent decision, approval, and execution outcome, so any incident can be reconstructed after the fact.",
      words: ["audit logging"],
      technology: "PostgreSQL with append-only triggers" },
    { id: "console", name: "Operations Console", category: "frontend",
      summary: "Is the one screen humans use to see an incident — technical detail or executive summary — and to approve or reject a proposed remediation.",
      words: ["present both technical and executive-friendly incident summaries", "human approval"],
      technology: "React, role-based views (engineer / approver / executive)" },
    { id: "claude-api", name: "Claude (Anthropic API)", category: "external",
      summary: "Provides the reasoning every agent calls on to explain failures, assess impact, and write summaries in plain language.",
      words: ["identify root causes using Claude", "AI agents"],
      technology: "Anthropic Claude API — Sonnet 5, Opus 5, and Haiku 4.5 at different agent tiers" },
    { id: "platforms", name: "Monitored Enterprise Platforms", category: "external",
      summary: "Is the actual SQL Server, SSIS, SSRS, and Windows Server infrastructure being watched, and — after approval — safely acted on.",
      words: ["SQL Server, SSIS, SSRS, Windows servers, and enterprise data platforms"],
      technology: "Existing enterprise infrastructure (not built by this project)" },
    { id: "user", name: "Human User", category: "actor",
      summary: "Whoever opens the console to read an incident or approve a fix — same login, different view depending on role.",
      words: ["human approval for high-risk actions", "executive-friendly"],
      technology: "—" }
  ],

  architecture: {
    mermaid: "flowchart TD\n    User([\"Human User<br/>(Engineer / Approver / Executive)\"])\n    Platforms{{\"Monitored Enterprise Platforms<br/>SQL Server, SSIS, SSRS, Windows Servers\"}}\n    ClaudeAPI{{\"Claude (Anthropic API)\"}}\n\n    Collectors[\"Telemetry Collectors<br/>(read-only)\"]\n    Bus[\"Event Bus\"]\n    Correlation[\"Correlation Engine\"]\n    Orchestrator[\"AI Agent Orchestrator\"]\n    RCA[\"Root Cause Analysis Agent\"]\n    ImpactRem[\"Impact & Remediation Agent\"]\n    Summary[\"Summary Generation Agent\"]\n    MCP[\"MCP Tool Gateway\"]\n    Approval[\"Approval Workflow Service\"]\n    Execution[\"Execution Service\"]\n    Console[\"Operations Console\"]\n\n    TelemetryStore[(\"Telemetry Store\")]\n    DependencyMap[(\"Service Dependency Map\")]\n    IncidentStore[(\"Incident Store\")]\n    AuditLog[(\"Audit Log Store\")]\n\n    Platforms -- \"metrics, job status, error logs\" --> Collectors\n    Collectors -- \"telemetry events\" --> Bus\n    Bus -- \"raw events\" --> TelemetryStore\n    Bus -- \"raw events\" --> Correlation\n    Correlation -- \"recent history query\" --> TelemetryStore\n    Correlation -- \"grouped incident\" --> IncidentStore\n    IncidentStore -- \"new incident trigger\" --> Orchestrator\n\n    Orchestrator -- \"investigate incident\" --> RCA\n    RCA -- \"read-only diagnostic query\" --> MCP\n    MCP -- \"read-only query\" --> Platforms\n    RCA -- \"reasoning request\" --> ClaudeAPI\n    RCA -- \"probable root cause\" --> Orchestrator\n\n    Orchestrator -- \"root cause + incident\" --> ImpactRem\n    ImpactRem -- \"dependency lookup\" --> DependencyMap\n    ImpactRem -- \"reasoning request\" --> ClaudeAPI\n    ImpactRem -- \"impact + remediation script\" --> Orchestrator\n\n    Orchestrator -- \"full findings\" --> Summary\n    Summary -- \"reasoning request\" --> ClaudeAPI\n    Summary -- \"technical + executive summaries\" --> IncidentStore\n\n    Orchestrator -- \"high-risk remediation\" --> Approval\n    Approval -- \"approve / reject decision\" --> Console\n    Console -- \"approval decision\" --> Execution\n    Execution -- \"run approved script (write)\" --> MCP\n    MCP -- \"write action\" --> Platforms\n    Execution -- \"execution outcome\" --> IncidentStore\n\n    IncidentStore -- \"incident state\" --> Console\n    Console -- \"incident view\" --> User\n    User -- \"approve / reject click\" --> Approval\n\n    Orchestrator -- \"agent decisions\" --> AuditLog\n    Approval -- \"approval decision\" --> AuditLog\n    Execution -- \"execution record\" --> AuditLog\n    MCP -- \"every tool call\" --> AuditLog",
    interpretation: "Telemetry only ever flows up and in from the monitored platforms; the single arrow going back out with a write happens only after Execution Service receives an approval decision from a human.",
    deploymentNotes: "The Collectors, MCP Tool Gateway, and Execution Service run closest to the monitored platforms (on-prem or in the same VNet), each under its own least-privilege service account — a read-only account for everything except the Execution Service's single write-scoped account. The Event Bus, Telemetry Store, Correlation Engine, Orchestrator, the three AI agents, Incident Store, Approval Workflow Service, Audit Log Store, and Operations Console run centrally (a Kubernetes namespace or equivalent), scaled independently since telemetry volume, correlation load, and AI agent concurrency all grow at different rates. Only the MCP Tool Gateway and Execution Service need network reachability into the monitored platforms; everything else only needs reachability to the Event Bus, the data stores, and the Anthropic API — which keeps the blast radius of a compromised central-cluster credential away from production write access.",
    securityNotes: "Read access and write access are enforced by different service accounts, not by an in-process flag — the Execution Service physically cannot obtain a write-capable credential to the Telemetry Collectors' or MCP Tool Gateway's read path. Risk classification for “is this remediation high-risk” is a deterministic policy table (action type × target platform × environment), not a judgment call handed to Claude, so an agent cannot reason its way around the approval gate. Every credential is stored outside the repo/config and redacted in any log line that references it."
  },

  dataFlow: {
    steps: [
      { n: 1, title: "Collectors poll the platforms", detail: "Telemetry Collectors poll SQL Server, SSIS, SSRS, and Windows Servers on a fixed interval, read-only, and detect a change in job status, error count, or a performance counter.", touchesModel: false },
      { n: 2, title: "Events published and stored", detail: "Collectors publish a telemetry event onto the Event Bus and write the raw sample to the Telemetry Store.", touchesModel: false },
      { n: 3, title: "Failures correlated", detail: "The Correlation Engine consumes events off the Event Bus, compares them against recent history in the Telemetry Store, and groups near-simultaneous failures across services into a single incident.", touchesModel: false },
      { n: 4, title: "Incident created, orchestration triggered", detail: "The Correlation Engine writes the incident to the Incident Store, which triggers the AI Agent Orchestrator.", touchesModel: false },
      { n: 5, title: "Root cause investigated", detail: "The Orchestrator calls the Root Cause Analysis Agent, which uses the MCP Tool Gateway's read-only path to run diagnostic queries against the affected platform, then asks Claude to reason over the telemetry and query results together.", touchesModel: true },
      { n: 6, title: "Root cause recorded", detail: "The Root Cause Analysis Agent returns a probable root cause; the Orchestrator writes it back to the Incident Store.", touchesModel: true },
      { n: 7, title: "Impact assessed, remediation drafted", detail: "The Orchestrator calls the Impact & Remediation Agent with the root cause. The agent looks up the Service Dependency Map for downstream business impact and asks Claude to draft a remediation plan plus a diagnostic SQL or PowerShell script.", touchesModel: true },
      { n: 8, title: "Summaries generated", detail: "The Orchestrator calls the Summary Generation Agent with the root cause, impact, and remediation plan; Claude produces a technical summary and an executive-friendly summary, both written to the Incident Store.", touchesModel: true },
      { n: 9, title: "High-risk remediation routed to approval", detail: "If the remediation is flagged high-risk by the deterministic risk policy, the Orchestrator routes it to the Approval Workflow Service instead of straight to execution.", touchesModel: false },
      { n: 10, title: "Human reviews and decides", detail: "A Human User opens the Operations Console, reviews the incident in the view suited to their role, and approves or rejects the remediation.", touchesModel: false },
      { n: 11, title: "Approved script executed", detail: "On approval, the Execution Service calls the MCP Tool Gateway's gated write path to run the approved script against the target platform, and records the outcome in the Incident Store.", touchesModel: false },
      { n: 12, title: "Everything audited in real time", detail: "Every tool call, agent decision, approval decision, and execution outcome is appended to the Audit Log Store as it happens — the audit trail is written in real time, not reconstructed after the fact.", touchesModel: false }
    ],
    mermaid: "sequenceDiagram\n    participant Platforms as Monitored Platforms\n    participant Collectors as Telemetry Collectors\n    participant Bus as Event Bus\n    participant Correlation as Correlation Engine\n    participant Orchestrator as AI Agent Orchestrator\n    participant RCA as Root Cause Agent\n    participant MCP as MCP Tool Gateway\n    participant Claude as Claude API\n    participant ImpactRem as Impact & Remediation Agent\n    participant Console as Operations Console\n    participant Approval as Approval Workflow\n    participant Execution as Execution Service\n    participant Audit as Audit Log Store\n\n    Platforms->>Collectors: metrics, job status, error logs\n    Collectors->>Bus: telemetry event\n    Bus->>Correlation: raw events\n    Correlation->>Correlation: group by time window + service graph\n    Correlation->>Orchestrator: correlated incident\n    Orchestrator->>RCA: investigate incident\n    RCA->>MCP: read-only diagnostic query\n    MCP->>Platforms: query (no write)\n    RCA->>Claude: reasoning request\n    Claude-->>RCA: probable root cause\n    RCA-->>Orchestrator: root cause\n    Orchestrator->>ImpactRem: root cause + incident\n    ImpactRem->>Claude: reasoning request\n    Claude-->>ImpactRem: impact + remediation script\n    ImpactRem-->>Orchestrator: impact + remediation\n    Orchestrator->>Approval: high-risk remediation\n    Approval->>Console: pending approval\n    Console->>Approval: human approves\n    Approval->>Execution: run approved script\n    Execution->>MCP: gated write call\n    MCP->>Platforms: write action\n    Execution->>Audit: execution record",
    interpretation: "Everything above the approval step only reads; the one write in the whole sequence happens on the second-to-last line, and only because a human approved it two lines earlier."
  },

  buildOrder: {
    phases: [
      { n: 1, name: "Read-only foundation", weeks: 3, risk: "low",
        builds: ["Telemetry Collectors", "Event Bus", "Telemetry Store", "Operations Console (read-only view)"],
        proves: "The system can continuously ingest real telemetry from SQL Server, SSIS, SSRS, and Windows Servers without touching anything, and a human can see raw incidents." },
      { n: 2, name: "Correlation", weeks: 2, risk: "low",
        builds: ["Correlation Engine", "Incident Store"],
        proves: "A flood of raw events becomes one grouped incident instead of noise — deterministically, before any AI is involved." },
      { n: 3, name: "AI diagnosis", weeks: 3, risk: "medium",
        builds: ["AI Agent Orchestrator", "Root Cause Analysis Agent", "MCP Tool Gateway (read path)", "Claude integration"],
        proves: "Claude can actually explain why something broke using live read-only evidence, not just restate the telemetry." },
      { n: 4, name: "Business context", weeks: 2, risk: "medium",
        builds: ["Service Dependency Map", "Impact & Remediation Agent"],
        proves: "The system can say who and what is affected downstream, and propose a concrete, safe fix — not just a diagnosis." },
      { n: 5, name: "Executive layer", weeks: 2, risk: "low",
        builds: ["Summary Generation Agent", "dual-view Console"],
        proves: "The same incident produces a usable executive summary with no human rewrite required." },
      { n: 6, name: "Controlled action", weeks: 3, risk: "high",
        builds: ["Approval Workflow Service", "Execution Service", "MCP Tool Gateway (write path)", "Audit Log Store"],
        proves: "The system can safely execute a remediation — only with a human's sign-off and a full audit trail. The highest-risk capability, built last and gated hardest." }
    ],
    mermaid: "gantt\n    title Build Order\n    dateFormat  YYYY-MM-DD\n    axisFormat %m/%d\n    section Phase 1\n    Read-only foundation   :p1, 2026-01-01, 3w\n    section Phase 2\n    Correlation             :p2, after p1, 2w\n    section Phase 3\n    AI diagnosis             :p3, after p2, 3w\n    section Phase 4\n    Business context          :p4, after p3, 2w\n    section Phase 5\n    Executive layer             :p5, after p4, 2w\n    section Phase 6\n    Controlled action             :crit, p6, after p5, 3w",
    interpretation: "The riskiest capability — anything that can write to production — is scheduled last, on purpose, and only after five earlier phases have already proven the read path works."
  },

  assumptions: [
    { assumption: "Read-only service accounts can be provisioned on every target SQL Server, SSIS, SSRS, and Windows Server host.",
      impact: "The “read-only monitoring layer” requirement can't be met without a provisioning/firewall project before Phase 1 can even start." },
    { assumption: "A Service Dependency Map exists or can be hand-built and maintained by ops — it is not auto-discovered from platform metadata.",
      impact: "The Impact & Remediation Agent's business-impact statements are only as good as this map; if it's stale, impact assessments will be confidently wrong even when the root cause is right." },
    { assumption: "“High-risk” remediation can be classified by a fixed, external policy (action type × target × environment), not left to the AI to judge.",
      impact: "If risk classification were the AI's call, an agent could reason its way around the approval gate — the policy must be deterministic and outside the model." },
    { assumption: "A single correlation time window (e.g., 5 minutes) is enough to group cross-service failures.",
      impact: "Too short misses slow-cascading failures (an SSIS failure that only shows up as an SSRS report gap an hour later); too long merges unrelated incidents into one false pattern." },
    { assumption: "The organization has its own Anthropic API access for the agents, separate from any personal key used elsewhere.",
      impact: "No architectural impact — noted only so the two Claude integrations (this system's agents vs. any other tool) aren't assumed to share a key or a budget." }
  ],

  notCovered: [
    { item: "Auto-discovery of the Service Dependency Map", why: "It's assumed to be maintained by ops or synced from a separate CMDB; this design doesn't include a discovery crawler." },
    { item: "Multi-tenant isolation", why: "This is one enterprise watching its own infrastructure, not a shared platform serving multiple customers." },
    { item: "High availability for the Ops Center's own infrastructure", why: "Event Bus replication, database failover, multi-region — called out as a deployment concern, not designed in diagram-level detail here." },
    { item: "Cost and rate-limit controls on Claude API usage during an incident storm", why: "Hundreds of correlated incidents firing at once needs a throttling/backpressure design of its own before production." },
    { item: "Long-term retention and archival policy", why: "Both the Telemetry Store and Audit Log Store will grow without bound as designed." },
    { item: "Non-Microsoft-stack platforms", why: "Scoped strictly to what the idea named: SQL Server, SSIS, SSRS, Windows Servers, and enterprise data platforms in that family." }
  ],

  openQuestion: {
    question: "Does “human approval for high-risk actions” mean the Execution Service ever runs anything automatically for low-risk actions, or does every remediation — without exception — require a human click?",
    forkA: { label: "Nothing ever runs unattended", consequence: "The Execution Service and Approval Workflow Service collapse into one gate with no auto-execute path. The risk-policy table in Assumptions becomes unnecessary — every remediation is high-risk by definition." },
    forkB: { label: "Low-risk actions can auto-run", consequence: "The design above is correct as drawn, but the risk-policy table becomes the single most security-critical artifact in the whole system — it needs its own review process, versioning, and audit trail separate from the Audit Log Store's per-incident records." }
  },

  coverage: [
    { concern: "Continuous telemetry monitoring", status: "covered", note: "Telemetry Collectors + Event Bus + Telemetry Store" },
    { concern: "Cross-service failure correlation", status: "covered", note: "Correlation Engine" },
    { concern: "AI root cause analysis", status: "covered", note: "Root Cause Analysis Agent" },
    { concern: "Downstream business impact assessment", status: "covered", note: "Impact & Remediation Agent + Service Dependency Map" },
    { concern: "Safe remediation recommendations", status: "covered", note: "Impact & Remediation Agent" },
    { concern: "Diagnostic SQL / PowerShell script generation", status: "covered", note: "Impact & Remediation Agent output" },
    { concern: "Technical + executive incident summaries", status: "covered", note: "Summary Generation Agent + dual-view Console" },
    { concern: "Event-driven workflow", status: "covered", note: "Event Bus" },
    { concern: "Audit logging", status: "covered", note: "Audit Log Store" },
    { concern: "Human approval for high-risk actions", status: "covered", note: "Approval Workflow Service" },
    { concern: "Read-only monitoring boundary", status: "covered", note: "Collectors + MCP Tool Gateway read/write split" },
    { concern: "High availability / DR for the Ops Center itself", status: "partial", note: "Deployment topology noted; not designed in diagram-level detail" },
    { concern: "Auto-discovery of service dependencies", status: "not-covered", note: "See What This Design Does Not Cover" },
    { concern: "Multi-tenant isolation", status: "not-covered", note: "See What This Design Does Not Cover" },
    { concern: "Claude API cost / rate-limit controls under incident storms", status: "not-covered", note: "See What This Design Does Not Cover" },
    { concern: "Long-term retention / archival policy", status: "not-covered", note: "See What This Design Does Not Cover" },
    { concern: "Non-Microsoft-stack platforms", status: "not-covered", note: "See What This Design Does Not Cover" }
  ],

  sections: [
    { id: "idea", file: "01-idea.html", title: "The Idea", shortTitle: "Idea",
      description: "The one-paragraph project idea, and the 14 phrases in it that drove every component below." },
    { id: "components", file: "02-components.html", title: "Components", shortTitle: "Components",
      description: "18 components — 15 built, 2 external, 1 human actor — each traced back to the words that required it." },
    { id: "architecture", file: "03-how-it-fits-together.html", title: "How It Fits Together", shortTitle: "Architecture",
      description: "The full Mermaid architecture diagram, deployment topology, and the security guarantee the design is built around." },
    { id: "dataflow", file: "04-data-flow.html", title: "Data Flow", shortTitle: "Data Flow",
      description: "A 12-step numbered walkthrough of one incident from first telemetry sample to closed, audited remediation." },
    { id: "buildorder", file: "05-build-order.html", title: "Build Order", shortTitle: "Build Order",
      description: "Six phases, each proving one capability before the next is allowed to depend on it." },
    { id: "assumptions", file: "06-assumptions.html", title: "Assumptions", shortTitle: "Assumptions",
      description: "5 assumptions this design rests on, and exactly what breaks if each one is wrong." },
    { id: "coverage", file: "07-not-covered.html", title: "Coverage & What's Not Covered", shortTitle: "Coverage",
      description: "11 concerns fully covered, 1 partial, 5 explicitly out of scope — plus the one open question that would most change the design." }
  ]
};
