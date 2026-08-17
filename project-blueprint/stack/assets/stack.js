/*
  STACK is the single source of data for the tech-stack knowledge base.
  Every page (index.html and every 0N-*.html) renders from this object via
  site.js. Nothing here is a property of `window` — other scripts must
  reference the bare identifier `STACK`, not `window.STACK`, because a
  top-level `const` does not attach itself to the global object.
*/
const STACK = {

  meta: {
    title: "AI Operations Center — Tech Stack",
    subtitle: "One real technology per architecture component, rated for fit to this project's actual scale.",
    generatedNote: "Generated from project-blueprint/architecture.md using the tech-stack-recommender method. Every rating is graded against this project's scale, not general popularity.",
    sourceFile: "../architecture.md",
    mdFile: "../tech-stack.md"
  },

  fitKey: [
    { id: "green", icon: "🟢", label: "Great fit", desc: "Matches this project's size and needs. Pick it, move on." },
    { id: "amber", icon: "🟡", label: "Good fit", desc: "Works, but there is a real caveat worth reading first." },
    { id: "red", icon: "🔴", label: "Consider carefully", desc: "Where this plan is most likely to hurt you — still the best available recommendation." },
    { id: "na", icon: "—", label: "Not a decision", desc: "Existing infrastructure, or a person — not a technology this project picks." }
  ],

  headline: "This stack's biggest risk isn't a wrong technology pick — it's an operational skill gap. Two components (the Event Bus and, to a lesser extent, the hosting layer implied by the data flow) require real distributed-systems operating experience, landing on a team whose proven depth is SQL Server, SSIS, SSRS, and Windows Server administration, not stream-processing or Kubernetes operations. Everything else is either PostgreSQL (reused five times), Claude API calls (Anthropic runs that infrastructure, not you), or small, contained services with no meaningful lock-in. If this plan fails, it's more likely to fail at “the Event Bus fell over during an incident storm and nobody knew how to bring it back” than at “the AI gave a bad answer.”",

  categories: [
    { id: "touch", label: "Things a Person Touches", short: "Touch", desc: "The one surface humans actually click around in." },
    { id: "write", label: "Things You Write", short: "Write", desc: "Services and agents this project builds." },
    { id: "store", label: "Things You Store", short: "Store", desc: "Where state lives." },
    { id: "dependOn", label: "Things You Depend On", short: "Depend On", desc: "Off-the-shelf infrastructure and external services." },
    { id: "dataflow", label: "What the Data Flow Needs", short: "Data Flow", desc: "Implied by the data flow and deployment notes — never named as a component row." }
  ],

  lockInLevels: [
    { id: "easy", label: "Easy", desc: "Swap it without touching anything else." },
    { id: "moderate", label: "Moderate", desc: "A real but contained rewrite." },
    { id: "hard", label: "Hard", desc: "Touches most of the system, or carries compliance weight." }
  ],

  recommendations: [
    { id: "console", component: "Operations Console", category: "touch", technology: "React", fit: "amber", runsOn: "yours",
      why: "React is a widely-used toolkit (a “component-based” approach, meaning the screen is assembled from reusable building blocks) for a UI with different views per role.",
      caveat: "Given how Microsoft-centric everything else here is (SQL Server, SSIS, SSRS, Windows Server), a Blazor app (Microsoft's own web UI framework, using C# instead of JavaScript) would let the team lean on skills they likely already have. This is a genuine toss-up worth a real side-by-side before committing.",
      learnPrompt: "Explain React to me like I'm new to frontend frameworks, using my AI Operations Center project's Operations Console as the example — and compare it to Blazor for my team.",
      alternative: { name: "Blazor", why: "Better matches the team's likely .NET background; React has the deeper industry-wide hiring pool and ecosystem. Genuinely close." },
      lockIn: "moderate", lockInWhy: "A frontend rewrite, contained to one layer.",
      confidence: "low" },

    { id: "correlation", component: "Correlation Engine", category: "write", technology: "Faust (Python stream processing)", fit: "green", runsOn: "yours",
      why: "Faust is a Python library (a reusable code toolkit) for grouping events that happened close together in time, in plain readable code — not a black-box AI decision.",
      learnPrompt: "Explain Faust to me like I'm new to stream processing, using my AI Operations Center project's Correlation Engine as the example.",
      alternative: { name: "Hand-rolled Kafka consumer", why: "Faust already solves “read from Kafka reliably” safely; reinventing it by hand is easy to get subtly wrong." },
      lockIn: "easy", lockInWhy: "One internal service; nothing else depends on the library choice." },

    { id: "orchestrator", component: "AI Agent Orchestrator", category: "write", technology: "Claude Agent SDK", fit: "green", runsOn: "yours",
      why: "Anthropic's own toolkit for running a fixed sequence of Claude-calling steps in the same order every time, with state-tracking built in.",
      learnPrompt: "Explain the Claude Agent SDK to me like I'm new to AI agent frameworks, using my AI Operations Center project's Orchestrator as the example.",
      alternative: { name: "Hand-rolled orchestration", why: "Lower lock-in, but rebuilds state-tracking and retry handling the SDK already provides." },
      lockIn: "moderate", lockInWhy: "Orchestration logic is tied to SDK conventions." },

    { id: "rca-agent", component: "Root Cause Analysis Agent", category: "write", technology: "Claude Sonnet 5", fit: "green", runsOn: "vendor",
      why: "A strong-reasoning, mid-cost model — this agent runs on every single incident, so cost adds up fast, but the reasoning still needs to be trustworthy.",
      learnPrompt: "Explain Claude Sonnet 5 to me like I'm new to choosing AI models, using my AI Operations Center project's Root Cause Analysis Agent as the example.",
      alternative: { name: "Claude Haiku 4.5", why: "Cheaper, but too light for root-cause reasoning trusted to explain a production incident." },
      lockIn: "easy", lockInWhy: "A config-level model swap." },

    { id: "impact-agent", component: "Impact & Remediation Agent", category: "write", technology: "Claude Opus 5", fit: "amber", runsOn: "vendor",
      why: "Anthropic's most capable model, reserved for the one agent whose output — an actual script a human might approve for production — carries the highest cost if wrong.",
      caveat: "Running the most expensive model on every incident (not just high-risk ones) is a real cost tradeoff worth pricing out, not an obvious win.",
      learnPrompt: "Explain Claude Opus 5 to me like I'm new to choosing AI models, using my AI Operations Center project's Impact & Remediation Agent as the example, and help me think through the cost tradeoff.",
      alternative: { name: "Claude Sonnet 5", why: "Cheaper and would work, but this agent's output is the single highest-stakes artifact in the system — worth paying for the strongest model here specifically." },
      lockIn: "easy", lockInWhy: "A config-level model swap." },

    { id: "summary-agent", component: "Summary Generation Agent", category: "write", technology: "Claude Haiku 4.5", fit: "green", runsOn: "vendor",
      why: "The fastest, cheapest current model — a good fit because this agent rewrites already-assembled facts into two summaries, a well-defined writing task, not open-ended reasoning.",
      learnPrompt: "Explain Claude Haiku 4.5 to me like I'm new to choosing AI models, using my AI Operations Center project's Summary Generation Agent as the example.",
      alternative: { name: "Claude Sonnet 5", why: "Unnecessary spend for a rewriting task with no ambiguity to reason through." },
      lockIn: "easy", lockInWhy: "A config-level model swap." },

    { id: "mcp", component: "MCP Tool Gateway", category: "write", technology: "Model Context Protocol (MCP) servers", fit: "green", runsOn: "yours",
      why: "MCP is an open standard (a public specification, not one vendor's product) built specifically for giving an AI agent a permissioned way to reach outside systems — the read/write split is enforced by the protocol itself.",
      learnPrompt: "Explain the Model Context Protocol (MCP) to me like I'm new to AI tool integrations, using my AI Operations Center project's MCP Tool Gateway as the example.",
      alternative: { name: "Custom REST API layer", why: "Means reinventing permissioning and auditing MCP already standardizes." },
      lockIn: "moderate", lockInWhy: "The standard is portable; the specific gateway build isn't." },

    { id: "approval", component: "Approval Workflow Service", category: "write", technology: "PostgreSQL status column + existing Event Bus", fit: "green", runsOn: "yours",
      why: "Tracking “pending / approved / rejected” as one column on an existing table, using infrastructure already being built, instead of a whole new workflow-engine product.",
      learnPrompt: "Explain how to build a simple approval workflow with a status column and a message queue, using my AI Operations Center project's Approval Workflow Service as the example.",
      alternative: { name: "Dedicated workflow engine (e.g. Camunda)", why: "Over-engineering for “one decision per incident: approve or reject.”" },
      lockIn: "easy", lockInWhy: "A data-model tweak, not a migration." },

    { id: "execution", component: "Execution Service", category: "write", technology: "PowerShell 7 (Constrained Language Mode)", fit: "green", runsOn: "yours",
      why: "A real PowerShell security feature that blocks a script from doing anything beyond a pre-approved set of actions — matching this component's exact job.",
      learnPrompt: "Explain PowerShell Constrained Language Mode to me like I'm new to PowerShell security, using my AI Operations Center project's Execution Service as the example.",
      alternative: { name: "Containerized shell sandbox", why: "PowerShell is already the native, expected tool for Windows Server/SQL Server administration." },
      lockIn: "hard", lockInWhy: "Entangled with the system's core write-path security guarantee — the one component allowed to write to production." },

    { id: "telemetry-store", component: "Telemetry Store", category: "store", technology: "TimescaleDB", fit: "green", runsOn: "yours",
      why: "A PostgreSQL add-on (a plug-in that teaches an existing database new tricks) for efficient “what happened in the last hour” queries — reuses skills the team needs anyway.",
      learnPrompt: "Explain TimescaleDB to me like I'm new to time-series databases, using my AI Operations Center project's Telemetry Store as the example.",
      alternative: { name: "InfluxDB", why: "A second database technology to operate for a benefit this project's current scale doesn't clearly need." },
      lockIn: "moderate", lockInWhy: "Time-series query patterns would need rewriting on migration." },

    { id: "incident-store", component: "Incident Store", category: "store", technology: "PostgreSQL", fit: "green", runsOn: "yours",
      why: "A mature relational database (data in related tables) with ACID guarantees (a saved record is never left half-written, even mid-crash) — exactly what a record needs to survive detection through approval to execution.",
      learnPrompt: "Explain PostgreSQL to me like I'm new to databases, using my AI Operations Center project's Incident Store as the example. What tables would I actually have?",
      alternative: { name: "MongoDB (document store)", why: "Incident state has clear relationships a relational database expresses more safely than a document blob." },
      lockIn: "hard", lockInWhy: "The system's central record — most other services read from or write to it." },

    { id: "dependency-map", component: "Service Dependency Map", category: "store", technology: "PostgreSQL", fit: "green", runsOn: "yours",
      why: "Same database as the Incident Store, so the team maintains one system, not two, for hand-maintained reference data.",
      learnPrompt: "Explain how to design a PostgreSQL reference table to me like I'm new to databases, using my AI Operations Center project's Service Dependency Map as the example.",
      alternative: { name: "Spreadsheet or CMDB sync", why: "A CMDB integration is worth revisiting later (architecture.md's own “not covered” note), but hand-maintained PostgreSQL is the honest starting point." },
      lockIn: "easy", lockInWhy: "Low query complexity, ops-maintained reference data." },

    { id: "audit-log", component: "Audit Log Store", category: "store", technology: "PostgreSQL with append-only triggers", fit: "green", runsOn: "yours",
      why: "Database triggers (small automatic actions on every write) block any UPDATE or DELETE at the database level, so the audit trail can't be quietly altered even by a bug elsewhere.",
      learnPrompt: "Explain how PostgreSQL triggers can enforce an append-only log, using my AI Operations Center project's Audit Log Store as the example.",
      alternative: { name: "Dedicated event-sourcing/ledger technology", why: "Append-only triggers already give the tamper-resistance this project needs, without a new technology to operate." },
      lockIn: "hard", lockInWhy: "Audit history has compliance weight once real incidents are recorded." },

    { id: "collectors", component: "Telemetry Collectors", category: "dependOn", technology: "Telegraf", fit: "green", runsOn: "yours",
      why: "A free, actively-maintained agent (a small program that runs continuously and reports data) that already knows how to poll SQL Server and Windows counters.",
      learnPrompt: "Explain Telegraf to me like I'm new to monitoring agents, using my AI Operations Center project as the example.",
      alternative: { name: "Custom polling scripts per platform", why: "Four hand-built pollers is four things to keep working; Telegraf's maintained plugins cover most of it already." },
      lockIn: "easy", lockInWhy: "Only produces events onto the Event Bus in a known format." },

    { id: "event-bus", component: "Event Bus", category: "dependOn", technology: "Apache Kafka", fit: "red", runsOn: "yours",
      why: "A durable message log (it keeps a replayable history of every event, not just the latest) — the industry standard for high-volume, fan-out streams like continuous telemetry.",
      caveat: "Running Kafka well takes real distributed-systems operational skill — a genuine gap for a team whose expertise is SQL Server and Windows, not stream-processing infrastructure. Azure Service Bus (a managed queue, meaning Microsoft runs the servers for you) is worth comparing if the team is already Azure-based.",
      learnPrompt: "Explain Apache Kafka to me like I'm new to event streaming, using my AI Operations Center project as the example — and compare it to Azure Service Bus for my situation.",
      alternative: { name: "Azure Service Bus", why: "Managed and lowers operational burden for a non-distributed-systems team — the strongest genuine alternative in this whole document." },
      lockIn: "hard", lockInWhy: "The architectural backbone nearly every component touches.",
      confidence: "low" },

    { id: "claude-api", component: "Claude (Anthropic API)", category: "dependOn", technology: "Anthropic Claude API", fit: "green", runsOn: "vendor",
      why: "The reasoning engine the project idea names directly, used at three cost/capability tiers depending on each agent's job.",
      learnPrompt: "Explain how the Anthropic Claude API works, using my AI Operations Center project's three different agents as the example.",
      alternative: { name: "—", why: "Not seriously considered — the source idea specifies Claude by name." },
      lockIn: "moderate", lockInWhy: "Agents are built around Claude's specific API shape; the MCP layer stays provider-agnostic." },

    { id: "hosting", component: "Hosting / Container Orchestration", category: "dataflow", technology: "Kubernetes", fit: "amber", runsOn: "yours",
      why: "A system for running many small services (containers, meaning each service is packaged to run identically anywhere) that scales the ones that need it — the architecture's own deployment notes call for exactly this.",
      caveat: "Real operational overhead for a team that doesn't already run it. A managed offering (Azure Kubernetes Service) meaningfully lowers that burden. A simpler fixed set of VMs is reasonable for an early Phase 1–2 build but won't hold up once Phase 6 needs independently-scaled AI agent concurrency.",
      learnPrompt: "Explain Kubernetes to me like I'm new to container orchestration, using my AI Operations Center project's central services as the example.",
      alternative: { name: "Fixed VMs / Docker Compose", why: "Simpler and fine for an early build, but doesn't hold up once Phase 6 needs independent scaling." },
      lockIn: "hard", lockInWhy: "A re-platforming project if changed later.",
      confidence: "low" },

    { id: "secrets", component: "Secrets Management", category: "dataflow", technology: "Azure Key Vault", fit: "green", runsOn: "vendor",
      why: "A locked vault that hands out passwords and API keys to services at runtime, so service accounts and the Anthropic API key never sit in a config file.",
      learnPrompt: "Explain Azure Key Vault to me like I'm new to secrets management, using my AI Operations Center project's service accounts and Anthropic API key as the example.",
      alternative: { name: "HashiCorp Vault", why: "Cloud-neutral and strong, but Azure Key Vault fits an already Azure-adjacent, Windows Server/SQL Server environment more directly." },
      lockIn: "moderate", lockInWhy: "Services' secret-fetching code would need to change on migration." },

    { id: "self-monitoring", component: "Self-Monitoring", category: "dataflow", technology: "Grafana + Loki", fit: "amber", runsOn: "yours",
      why: "Monitoring for the Ops Center's own health (is the Correlation Engine keeping up, is an agent timing out) — a different concern from the Telemetry Store, which watches the platforms being managed.",
      caveat: "The architecture explicitly calls this “not designed in diagram-level detail” — treat it as a real Phase 6+ build item, not an afterthought.",
      learnPrompt: "Explain Grafana and Loki to me like I'm new to observability tooling, using my AI Operations Center project's own infrastructure (not the platforms it monitors) as the example.",
      alternative: { name: "Reuse TimescaleDB + a custom dashboard", why: "Mixing the Ops Center's own operational metrics into the store used to watch external platforms blurs a boundary worth keeping separate." },
      lockIn: "easy", lockInWhy: "Sits alongside the architecture, not inside its data flow." }
  ],

  notApplicable: [
    { component: "Monitored Enterprise Platforms", note: "The existing SQL Server, SSIS, SSRS, and Windows Server environment already in production." },
    { component: "Human User", note: "The engineer, approver, or executive using the console." }
  ],

  learningOrder: [
    { n: 1, technology: "PostgreSQL", why: "The one technology reused five times. Learn this first; everything else assumes it." },
    { n: 2, technology: "Containers (Docker basics)", why: "Needed before Kubernetes makes sense." },
    { n: 3, technology: "Apache Kafka", why: "The highest-risk, hardest-to-undo piece. Understand it early, deliberately." },
    { n: 4, technology: "Telegraf", why: "Simple, low-risk, a quick early win." },
    { n: 5, technology: "Anthropic Claude API basics", why: "Model tiers, pricing, how a request/response works." },
    { n: 6, technology: "Claude Agent SDK", why: "Builds directly on Claude API knowledge." },
    { n: 7, technology: "Model Context Protocol (MCP)", why: "Builds on both Claude API and agent knowledge — makes the safety guarantee real." },
    { n: 8, technology: "React or Blazor", why: "Settle the Operations Console question before building it twice." },
    { n: 9, technology: "Kubernetes", why: "Builds on Docker; tackle once the services it hosts are designed." },
    { n: 10, technology: "PowerShell Constrained Language Mode", why: "Narrow but critical — learn right before building the Execution Service." },
    { n: 11, technology: "Azure Key Vault", why: "Wire in early — retrofitting secrets management after credentials are hardcoded is painful." },
    { n: 12, technology: "Grafana + Loki", why: "Last on purpose; you need services running before you can watch them." }
  ],

  notCovered: [
    { item: "Exact Claude API costs at your real incident volume", why: "Model-tier choices are reasoned qualitatively; a real token-cost estimate needs your actual expected incident rate." },
    { item: "Kubernetes cluster sizing, node counts, or a full deployment topology", why: "The architecture names the pattern (independently-scaled services); this document doesn't size the cluster." },
    { item: "A confirmed cloud provider", why: "Azure Key Vault and AKS are recommended because the monitored platforms imply a Microsoft-adjacent environment — that's an inference, not a confirmed decision." },
    { item: "Whether your specific team already knows any of these tools", why: "Ratings are graded against the project's scale, not a specific team's current skills, except where explicitly flagged." },
    { item: "Procurement or contract status", why: "Whether Anthropic API access is already provisioned org-wide is an assumption in architecture.md this document doesn't resolve." },
    { item: "Disaster recovery / high availability for the Ops Center's own infrastructure", why: "architecture.md explicitly flags this as not designed in diagram-level detail; this document doesn't fill that gap either." }
  ],

  leastConfident: [
    { component: "Event Bus", why: "Kafka vs. Azure Service Bus is a real, close call, not a formality — hence the red rating." },
    { component: "Operations Console", why: "React vs. Blazor is a genuine toss-up given the team's likely .NET background." },
    { component: "Hosting", why: "Whether Kubernetes is justified from day one, or is over-engineering until Phase 6's independent-scaling need actually arrives." }
  ],

  sections: [
    { id: "summary", file: "01-summary.html", title: "Fit Key & Headline", shortTitle: "Summary",
      description: "What each rating means, and the one-paragraph headline for where this stack is most likely to break." },
    { id: "recommendations", file: "02-recommendations.html", title: "Recommendations", shortTitle: "Stack", grouped: true,
      description: "Every technology decision, grouped by what a person touches, writes, stores, depends on, and what the data flow needs." },
    { id: "prompts", file: "03-learn-prompts.html", title: "Learn-More Prompts", shortTitle: "Prompts",
      description: "Every copy-ready prompt in one table, each naming this project by name." },
    { id: "learnorder", file: "04-learn-order.html", title: "What to Learn First", shortTitle: "Learn Order",
      description: "A 12-step learning ladder, foundational technologies before specialized ones." },
    { id: "alternatives", file: "05-alternatives.html", title: "Alternatives Considered", shortTitle: "Alternatives",
      description: "The runner-up for every decision, and why it lost." },
    { id: "lockin", file: "06-lock-in.html", title: "How Hard to Undo", shortTitle: "Lock-In",
      description: "Which decisions are a config change, and which ones you'll live with for years." },
    { id: "notcovered", file: "07-not-covered.html", title: "What This Doesn't Tell You", shortTitle: "Not Covered",
      description: "Six things this document deliberately leaves unresolved, and why." },
    { id: "appendix", file: "08-appendix.html", title: "Appendix", shortTitle: "Appendix",
      description: "The full architecture cross-reference: every component, its technology, and its fit rating in one table." }
  ]
};
