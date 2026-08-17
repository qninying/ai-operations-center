/*
  MVP is the single source of data for the Week 1 MVP-plan knowledge base.
  Every page (index.html and every 0N-*.html) renders from this object via
  site.js. Nothing here is a property of `window` — other scripts must
  reference the bare identifier `MVP`, not `window.MVP`, because a
  top-level `const` does not attach itself to the global object.

  Content is transcribed from project-blueprint/mvp-plan.md. If the plan
  changes, change it here — no page hardcodes plan content of its own.
*/
const MVP = {

  meta: {
    title: "AI Operations Center — Week 1 MVP Plan",
    subtitle: "The smallest real build that answers the one question worth answering first.",
    generatedNote: "Generated from project-blueprint/architecture.md and project-blueprint/tech-stack.md using the mvp-scoper method. Every cut on these pages is deliberate — the plan is a subtraction, not a wish list.",
    sourceFile: "../mvp-plan.md",
    sourceLabel: "MVP Plan ↗",
    mockupFile: "../mockup.html",
    pitchFile: "../one-pager.pdf"
  },

  /* ------------------------------------------------------------------ */
  /* Section 1 — The Bet                                                 */
  /* ------------------------------------------------------------------ */

  question: "Can Claude take a hardcoded, already-correlated cross-service incident and produce a root-cause explanation an engineer would actually trust enough to act on — before any of the real infrastructure that would feed it real evidence gets built?",

  questionShort: "Can Claude explain a hardcoded incident well enough that an engineer would act on it?",

  building: [
    {
      component: "Incident Store",
      short: "Incident Store",
      description: "A minimal local PostgreSQL `incidents` table (id, raw_events, root_cause, technical_summary, executive_summary, status). Same technology as the full recommendation, just one local instance instead of the production data store."
    },
    {
      component: "Correlation Engine, stood in by hand",
      short: "Correlation, by hand",
      description: "A small script that inserts 2–3 hardcoded, realistic telemetry events (a SQL Server blocking chain and the SSIS job it stalls, arriving seconds apart) as one already-grouped incident row. Stands in for Faust + Kafka without building either."
    },
    {
      component: "Root Cause Analysis Agent",
      short: "Root Cause Agent",
      description: "A script that calls Claude Sonnet 5 — the model tech-stack.md picked for this exact agent — with the hardcoded event text and asks for a plain-English root cause. No live MCP Tool Gateway read access; simulated event details substitute for a real diagnostic query."
    },
    {
      component: "Summary Generation Agent",
      short: "Summary Agent",
      description: "A second script, using Claude Haiku 4.5 — again, the model already picked for this agent — that turns the root cause into one technical sentence and one executive-friendly sentence."
    },
    {
      component: "Operations Console",
      short: "Operations Console",
      description: "The thinnest possible version: one static page (or a CLI command) that reads the single incident row from Postgres and displays the correlated events, the root cause, and both summaries. No login, no roles, no approval buttons."
    }
  ],

  /* ------------------------------------------------------------------ */
  /* Section 3 — What's Cut                                              */
  /* ------------------------------------------------------------------ */

  cuts: [
    {
      cut: "Event Bus (Kafka)",
      short: "Kafka",
      proves: "The system survives high-volume, fan-out telemetry without falling over.",
      whyNot: "This week is about reasoning quality, not throughput. tech-stack.md already flags Kafka as the stack's biggest operational risk — no reason to take it on before it's load-bearing."
    },
    {
      cut: "Telemetry Collectors (Telegraf)",
      short: "Telegraf",
      proves: "Live polling against real SQL Server, SSIS, SSRS, and Windows Server actually works.",
      whyNot: "One hardcoded incident is enough to test whether Claude can reason over telemetry text; wiring real pollers is its own integration project."
    },
    {
      cut: "Telemetry Store (TimescaleDB)",
      short: "TimescaleDB",
      proves: "The Correlation Engine can compare a new event against real historical baselines.",
      whyNot: "This week's incident is fully hardcoded — there's no history yet to store or query against."
    },
    {
      cut: "MCP Tool Gateway (live read path)",
      short: "MCP Gateway",
      proves: "Claude can pull real diagnostic evidence from production systems safely.",
      whyNot: "Pre-written event text substitutes for a live query this week; the reasoning step can be tested without a real gateway in front of it."
    },
    {
      cut: "Service Dependency Map + Impact & Remediation Agent",
      short: "Impact & Remediation",
      proves: "Claude can trace downstream business impact and draft a safe remediation script.",
      whyNot: "Per architecture.md, this is the single highest-stakes agent in the whole design. It's next week's riskiest question, deliberately deferred until root-cause reasoning is validated first."
    },
    {
      cut: "Approval Workflow Service + Execution Service (the write path)",
      short: "The write path",
      proves: "A human can safely approve and execute a real change on production.",
      whyNot: "Nothing should be able to touch a monitored server yet, and per the architecture's own core guarantee, that has to stay true regardless of how this week goes."
    },
    {
      cut: "Audit Log Store",
      short: "Audit Log",
      proves: "Every decision is traceable for compliance.",
      whyNot: "Nothing consequential enough to audit happens yet — there's no write path to log."
    },
    {
      cut: "Role-based views + authentication in the Console",
      short: "Roles & auth",
      proves: "Engineers, approvers, and executives each see the right slice.",
      whyNot: "One unauthenticated read view is enough to judge whether the underlying reasoning is any good — that's the only question on the table."
    },
    {
      cut: "Kubernetes / any container orchestration",
      short: "Kubernetes",
      proves: "Central services scale independently under real concurrency.",
      whyNot: "Hosting is explicitly a Phase 6 decision in architecture.md's own build order, not a Week 1 one."
    },
    {
      cut: "Azure Key Vault / secrets management",
      short: "Key Vault",
      proves: "Service-account and API credentials are handled correctly at scale.",
      whyNot: "Week 1 has no real service-account credentials to protect — everything runs local and hardcoded."
    },
    {
      cut: "Grafana + Loki (self-monitoring)",
      short: "Grafana + Loki",
      proves: "The Ops Center can tell you it's unhealthy.",
      whyNot: "Nothing is running continuously yet, so there's nothing to self-monitor."
    }
  ],

  stackCutdown: [
    { component: "Incident Store", full: "PostgreSQL", week1: "Same — PostgreSQL, one local instance", kept: true },
    { component: "Correlation Engine", full: "Faust + Kafka", week1: "A plain insert script — no stream processing, no message bus", kept: false },
    { component: "AI Agent Orchestrator", full: "Claude Agent SDK, state machine per incident", week1: "Skipped — two scripts called in sequence by hand", kept: false },
    { component: "Root Cause Analysis Agent", full: "Claude Sonnet 5 + MCP Tool Gateway", week1: "Claude Sonnet 5 direct API call, no gateway — same model, simulated evidence", kept: true },
    { component: "Summary Generation Agent", full: "Claude Haiku 4.5", week1: "Same — Claude Haiku 4.5, direct API call", kept: true },
    { component: "Operations Console", full: "React, role-based views", week1: "One static HTML page or CLI, no framework, no roles", kept: true },
    { component: "Everything else (Kafka, TimescaleDB, MCP servers, Approval Workflow, Execution Service, Audit Log, Kubernetes, Key Vault, Grafana+Loki)", full: "—", week1: "Not built this week", kept: false }
  ],

  /* ------------------------------------------------------------------ */
  /* Section 2 — Five Days                                               */
  /* ------------------------------------------------------------------ */

  fiveDays: [
    {
      day: "Monday",
      short: "Table exists, row round-trips",
      outcome: "A local Postgres `incidents` table exists, and one hand-inserted row round-trips: insert it, query it, see it come back unchanged."
    },
    {
      day: "Tuesday",
      short: "Three hardcoded events, one row",
      outcome: "Three hardcoded telemetry events, written as a SQL Server blocking chain and the SSIS job it stalls seconds later, sit in the `incidents` table as one pre-grouped incident row."
    },
    {
      day: "Wednesday",
      short: "Sonnet 5 writes a root cause",
      outcome: "A script sends that incident's raw event text to Claude Sonnet 5, and a specific, non-generic root-cause sentence — naming the actual causal link between the blocking chain and the SSIS failure — is written back to the row."
    },
    {
      day: "Thursday",
      short: "Both summaries, one screen",
      outcome: "A second script sends the root cause to Claude Haiku 4.5, and both a technical summary and an executive summary land in the row; a static page reads the row and shows the events, root cause, and both summaries together on one screen."
    },
    {
      day: "Friday",
      short: "A real person reads it cold",
      outcome: "A real person who did not build this — ideally someone with actual SQL Server/SSIS operations experience — reads the screen cold, with no root cause told to them in advance, and says whether they'd trust the explanation enough to act on it."
    }
  ],

  /* ------------------------------------------------------------------ */
  /* Section 6 — Did It Work?                                            */
  /* ------------------------------------------------------------------ */

  successBar: "At least 2 of 3 test reviewers, reading only the screen and given no advance explanation, say the root-cause sentence matches what they'd have suspected themselves, and none of the three flag it as “confidently wrong.”",

  failureBar: "Claude produces a plausible-sounding but generic explanation that restates the symptoms instead of diagnosing a cause — “the SSIS job failed after the blocking chain appeared” instead of “the blocking chain held a lock the SSIS job's UPDATE step needed, which is why the job stalled, not a coincidence” — and a reviewer with real SQL Server ops experience calls it out as something they would not trust in production.",

  outcomes: [
    {
      outcome: "Pass",
      tone: "green",
      whatHappened: "2–3 of 3 reviewers trust the explanation",
      nextMove: "Proceed to the next real infrastructure step: wire up the MCP Tool Gateway's read path so the Root Cause Analysis Agent works from live evidence instead of hardcoded text — the next riskiest assumption in the design.",
      nextMoveShort: "Wire the MCP read path"
    },
    {
      outcome: "Partial",
      tone: "amber",
      whatHappened: "1 of 3 trusts it, or reviewers land on the right conclusion but find the reasoning shown unconvincing",
      nextMove: "Don't add infrastructure yet. Spend a second short cycle improving only the evidence and prompting shown to Claude — more realistic telemetry detail, a few real-incident examples — before touching MCP or Kafka.",
      nextMoveShort: "Second cycle on evidence"
    },
    {
      outcome: "Fail",
      tone: "red",
      whatHappened: "0 of 3 trust it, or explanations are consistently generic or wrong",
      nextMove: "Stop and reconsider the product. If Claude can't produce a trustworthy root cause from clean, hardcoded, favorable-case data, no amount of real-time infrastructure fixes that — the core value proposition needs rethinking before another line of code is written.",
      nextMoveShort: "Stop, reconsider the product"
    }
  ],

  /* ------------------------------------------------------------------ */
  /* Section 7 — Appendix                                                */
  /* ------------------------------------------------------------------ */

  provesNothing: [
    "Whether live, MCP-mediated queries against real SQL Server/SSIS/SSRS return evidence Claude can actually use.",
    "Whether the Correlation Engine can group failures accurately at real cross-service volume and timing, not a hand-picked 3-event example.",
    "The cost or latency of the three-model pipeline at real incident volume.",
    "Whether the Impact & Remediation Agent — the highest-stakes agent in the design — can safely draft a script a human should approve.",
    "Whether executives, not just engineers, find the executive summary actually useful.",
    "The soundness of the approval workflow or the security of the write path — neither exists yet, on purpose.",
    "Whether this architecture holds up under an incident storm (many correlated incidents firing at once)."
  ],

  groundedIn: [
    {
      label: "Architecture",
      file: "../architecture.md",
      fileLabel: "project-blueprint/architecture.md",
      detail: "Correlation Engine, Incident Store, AI Agent Orchestrator, Root Cause Analysis Agent, Summary Generation Agent, Operations Console."
    },
    {
      label: "Tech stack",
      file: "../tech-stack.md",
      fileLabel: "project-blueprint/tech-stack.md",
      detail: "PostgreSQL, Claude Sonnet 5, Claude Haiku 4.5, Claude Agent SDK."
    }
  ],

  /* ------------------------------------------------------------------ */
  /* Section 4 — The Mockup                                              */
  /* ------------------------------------------------------------------ */

  mockup: {
    file: "../mockup.html",
    title: "Operations Console — Incident INC-4471",
    intro: "A static, hand-built picture of the main screen: one incident, correlated events, a root cause, and both summaries. It is a drawing of the destination, not the Week 1 build — the Week 1 version of this screen has no sidebar, no roles, and no buttons.",
    openNote: "Opens in a new tab. A local file can't be shown inside an embedded frame from disk, so the link is a real link rather than an inline preview.",
    regions: [
      { id: "topbar", label: "Top bar", detail: "Brand, Incidents / Dependency Map / Audit Log nav, environment pill, signed-in approver." },
      { id: "sidebar", label: "Left sidebar", detail: "Open and resolved incidents, each with a status badge (Critical / Watching / Resolved), host, and age." },
      { id: "main", label: "Main panel", detail: "The selected incident in full: correlated events, root cause, downstream impact, recommended remediation, and both summaries." }
    ],
    notes: [
      "The root cause is a full causal sentence, not a restated symptom — it names the index rebuild as the root event and calls the SSIS failure a downstream symptom. That distinction is exactly what Friday's reviewers are being asked to judge.",
      "Both a technical summary and an executive summary appear on the same screen, with no separate export step and no second tool to open.",
      "The correlated events are shown above the explanation, in raw form with timestamps and hosts, so a reader can check the reasoning against the evidence instead of taking it on faith.",
      "The approve/reject row and the remediation script belong to the full product, not to Week 1 — the write path (Approval Workflow + Execution Service) is one of the eleven deliberate cuts. The Week 1 screen is read-only on purpose.",
      "The sidebar, the dependency map, the audit strip, and the role badge are all drawn here and all cut from Week 1. The mockup shows where this goes; the five days show what actually gets built."
    ]
  },

  /* ------------------------------------------------------------------ */
  /* Section 5 — The Pitch                                               */
  /* ------------------------------------------------------------------ */

  pitch: {
    file: "../one-pager.pdf",
    headline: "When a Report Breaks at 2 AM, Someone Should Already Know Why",
    subhead: "An always-on assistant that watches your data platform and explains failures in plain English — the moment they happen, not the morning after.",
    openNote: "Opens in a new tab or your PDF viewer. PDF embeds are unreliable from a local file, so this is a plain link rather than an inline frame. Everything in the one-pager is also summarized below, so this page stands on its own.",
    who: "IT operations teams running SQL Server, SSIS, SSRS, and Windows Server — and the business leaders whose reports depend on those systems finishing overnight.",
    why: "Every hour spent hunting through logs is an hour a decision waited on stale data. The failure is usually simple once someone finds it; finding it is the expensive part.",
    bullets: [
      {
        claim: "Turns log-hunting into a one-screen explanation",
        detail: "Correlated events, a root cause, and what it means, in one place instead of four consoles and a chat thread.",
        label: "Estimated",
        tone: "amber"
      },
      {
        claim: "Explains the failure two ways at once",
        detail: "One technical sentence for the engineer who has to fix it, one plain sentence for the executive whose report is late — from the same incident, at the same time.",
        label: "Estimated",
        tone: "amber"
      },
      {
        claim: "Never changes a live system without a person's sign-off",
        detail: "Nothing executes against a monitored server unless a named human approves it first. This is a design guarantee, not a performance estimate.",
        label: "Design guarantee",
        tone: "green"
      }
    ],
    whatsNext: "Testing whether the explanation is trustworthy enough to act on. One real failure, one screen, one week."
  },

  /* ------------------------------------------------------------------ */
  /* Sections — nav, breadcrumbs, tile grid, prev/next                   */
  /* ------------------------------------------------------------------ */

  sections: [
    { id: "bet", order: 1, file: "01-the-bet.html", title: "The Bet", shortTitle: "The Bet",
      subtitle: "The one question Week 1 answers, and the five things being built to answer it.",
      description: "The one question Week 1 answers, and the only five things being built to answer it." },
    { id: "fivedays", order: 2, file: "02-five-days.html", title: "The Five Days", shortTitle: "Five Days",
      subtitle: "Monday to Friday, each day an outcome you can point at rather than a task you can be busy with.",
      description: "Monday to Friday, written as outcomes — each one either happened or it didn't." },
    { id: "cuts", order: 3, file: "03-whats-cut.html", title: "What's Cut", shortTitle: "What's Cut",
      subtitle: "Everything deliberately left out of Week 1, what each cut would have proved, and why that isn't this week's question.",
      description: "Everything deliberately left out, what it would have proved, and why that isn't this week's question." },
    { id: "mockup", order: 4, file: "04-the-mockup.html", title: "The Mockup", shortTitle: "The Mockup",
      subtitle: "The main screen, drawn: one incident, its evidence, its root cause, and both summaries.",
      description: "The Operations Console screen, drawn — and what's worth noticing in it." },
    { id: "pitch", order: 5, file: "05-the-pitch.html", title: "The Pitch", shortTitle: "The Pitch",
      subtitle: "The one-pager: who needs this, why it matters, and what is actually being claimed.",
      description: "The one-page pitch — who needs this, why now, and which claims are estimates." },
    { id: "outcome", order: 6, file: "06-did-it-work.html", title: "Did It Work?", shortTitle: "Did It Work?",
      subtitle: "The success bar, the failure mode, and the three-way fork Friday lands on.",
      description: "What “it worked” looks like, what failure looks like, and the three moves Friday can lead to." },
    { id: "appendix", order: 7, file: "07-appendix.html", title: "Appendix", shortTitle: "Appendix",
      subtitle: "What Week 1 proves nothing about, and the two documents this plan is grounded in.",
      description: "What this week deliberately proves nothing about, plus the source documents." }
  ]
};
