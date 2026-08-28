# CoreOps — Expo Presentation Script

A live-demo speaking script, not a screencast voiceover — for walking an audience
through the running dashboard and the `solution-architecture-capstone.html` document
side by side. Everything below is real: every incident named, every number cited,
every gap disclosed is something this repo can actually show, today, not aspirational.

**Why gaps are disclosed before being asked, not after:** the goal of this
presentation is not "look, a finished product" — it's "look, an architect who knows
exactly where the edges of this system are." A reviewer who hears you name a gap
before they find it stops probing for the gaps you *didn't* mention. A reviewer who
has to extract a gap from you starts wondering what else you're not saying. Say the
honest thing first, every time — it's the strategy, not just a virtue.

**Format:** each beat has a spoken line in a blockquote and a stage direction in
brackets. Read the blockquotes as a starting point, not a script to recite word for
word — say it in your own voice, but keep the specific facts and numbers exact.

**Setup before presenting:** run `demo-start` (or its manual equivalent — see
`.claude/skills/demo-start/SKILL.md`) so the server, monitoring, and the Postgres/
Docker/Cloud fault schedule are already warm. Confirm you're logged in on your own
browser (not the Claude Code preview pane) before walking on stage.

---

## Opening — what CoreOps is (0:00–1:00)

> "CoreOps is an AI operations dashboard for SQL Server, SSIS, SSRS, and Windows
> infrastructure. It watches for real incidents, uses Claude to reason about root
> cause with real evidence behind every claim, and — for two of the five sources
> it monitors — it can now actually execute the fix. Not just recommend one.
>
> Before I show you a single incident, here's the one design rule everything else in
> this system answers to: nothing writes to a real system without a human explicitly
> approving it first. That's not a policy I'm telling you about — it's a structural
> gate in the code, and I'm going to prove it's real, not just describe it, as we go."

**[Action: dashboard already open, Overview tab. Point at the incident count.]**

> "This is a real, running system — not a mockup. Every number on this screen right
> now reflects real state: real SQL Server queries, a real Postgres database, a real
> Docker container, real evidence gathered live and handed to Claude."

---

## How it works — the shape before the specifics (1:00–2:30)

**[Action: stay on Overview, or pull up `architecture-summary.html` / the 7-layer
diagram in the capstone doc if presenting alongside it.]**

> "Every incident goes through the same four steps, regardless of source. Detect —
> something real is wrong, pulled from a real system, not a canned scenario. Reason —
> Claude gets the real evidence and produces a root cause, a confidence score, and the
> specific evidence it's citing — and I can independently verify that citation is
> real, not hallucinated. Propose — a specific, source-correct action, gated by
> deterministic safety rules that are never AI-decided. Approve — a human, me, right
> now, clicking a real button, and only then does anything execute.
>
> I'm going to walk five incidents in a specific order — not randomly, and not
> severity-sorted. Each one demonstrates a different layer of what this system
> actually does, building from the newest and most capable work backward to the
> simplest case."

---

## Beat 1 — Postgres: real judgment, real execution (2:30–5:00)

**[Action: scroll to the top Postgres incident card(s). If none are currently
active, this is the moment to say so and trigger one live — see "If nothing's
active" below.]**

> "This is the newest work in the system, finished the same day as this
> presentation. A real Postgres database, a real blocking query — one connection
> holds a row lock, another is genuinely stuck waiting on it. Watch what happens
> when I click Troubleshoot."

**[Action: click Troubleshoot on a Postgres card.]**

> "No AI call here, deliberately — this is a plain, deterministic connectivity and
> lock-chain check, not something worth spending a model call on. What decides
> whether this is safe to fix automatically is pure code: never touch a system
> process, never blind-kill a transaction that's been running more than five
> minutes, and if the blocker is itself blocked by something else, trace it to the
> real root instead of killing the wrong session. Same three rules a real DBA
> applies, written down as deterministic logic instead of left to an AI's judgment."

**[Action: click Fix, then Approve.]**

> "That real Approve click just ran an actual `pg_terminate_backend()` against
> the real database — not a simulation. And it doesn't just fire and assume it
> worked: it re-checks the database afterward, and only marks this resolved once
> it's independently confirmed the backend is actually gone. If I click Approve
> and it *doesn't* come back clean, this system tells me that honestly instead of
> claiming success."

**[If nothing's active: say so plainly — "there's no active Postgres incident at
this exact moment, let me trigger one live" — then run the `demo-postgres-incident`
skill's trigger step, or narrate that you're about to. Never silently skip to a
pre-resolved one and imply it just happened.]**

---

## Beat 2 — Docker: the first real execution, proven under pressure (5:00–7:00)

**[Action: scroll to the Docker/Superset incident, if active — see note below.]**

> "This is the first place I proved this system could execute a real fix, not just
> propose one. A real Superset container, genuinely stopped. Same shape as
> Postgres — Troubleshoot honestly says this is a plain health check, not something
> to hand to an AI, Fix proposes a real `docker restart`, and Approve runs it for
> real, then re-checks the container's actual health before calling it resolved."

**[If honestly discussing the finding process — optional but strong material:]**

> "I'll tell you something that happened building this feature, because it's a
> better demonstration of engineering judgment than a clean success would be. The
> first time I tested this against two Postgres incidents at once, approving *one*
> of them crashed the whole background process and silently killed the *other*
> one too — collateral damage from a shared error handler. I only found that by
> actually running it against a real database, not by reading the code. It's fixed
> now, and there's a regression test proving it, but I'm telling you about it
> because 'I tested it and it worked' means a lot more once you've heard about the
> time it didn't."

---

## Beat 3 — Cloud/SSIS: the reasoning layer, and how I know it isn't lying (7:00–9:30)

**[Action: scroll to the SSIS/Cloud incident, click Troubleshoot.]**

> "This one *does* go to Claude — a real diagnostics call, real evidence, a real
> confidence score. Here's the harder question a skeptic should ask at this point:
> what stops a wrong-but-confident AI answer from being approved anyway, since the
> human approver is reading the same evidence the model already reasoned over?
>
> Two real checks run underneath this response, both invisible unless something's
> wrong. First: every evidence id the model cites is checked against what it was
> actually given — if it cited something that doesn't exist, that's flagged, not
> trusted. Second, and newer: individual factual claims in its explanation are
> checked against the literal evidence field they claim to be drawn from. I proved
> both of these actually catch something, not just pass silently — I fabricated a
> bad citation and a mismatched claim in testing, and confirmed the warning banner
> for each one actually renders."

---

## Beat 4 — SQL: the deepest domain judgment in the system (9:30–12:00)

**[Action: scroll through the SQL Server incidents — there should be two, a safe
case and a refused case.]**

> "SQL Server is where the real DBA-judgment work started, and it's still the
> richest example of it. Watch — this first one, session 61 blocked by 52: short
> hold, ordinary session, no chain. Safe to auto-fix, and I can click straight
> through to Approve."

**[Action: walk that one through Fix → Approve if not already resolved.]**

> "This second one won't offer the same button. Session 84's blocker has been
> running over five minutes — a real DBA doesn't blind-kill a transaction that's
> been running that long, because forcing a rollback on real, possibly-legitimate
> work is its own kind of damage. The system tells me that directly instead of
> either refusing silently or pretending it's fine."

**[Optional, if time allows — name the other two rules even without a live
example:]**

> "There are two more real refusal reasons this same logic covers, even if I don't
> have a live example of each up right now: never touch a session SQL Server
> reserves for its own internal use, and if the blocker itself turns out to be
> blocked by something further up the chain, point at the real root cause instead
> of killing the wrong link."

---

## Beat 5 — SSRS: the simplest case, and why that's fine (12:00–13:00)

**[Action: scroll to an SSRS incident card, at the bottom of the list.]**

> "And last, deliberately — SSRS. This is the simplest detection in the system: a
> report execution log, a real non-success status, handed to Claude for the same
> evidence-grounded reasoning as the Cloud case. No new execution capability here,
> no new judgment layer — and that's fine. Not every incident needs to be the most
> sophisticated thing this system does. Ending here, on the plainest case, is
> deliberate: it's the floor this system guarantees for everything it watches, even
> the least complicated failure mode."

---

## Honest gaps — said before anyone has to ask (13:00–15:30)

> "Before you ask, here's exactly where this system's edges are today. I'd rather
> tell you than have you find it."

- **"SQL Server, SSRS, and Cloud remediations still don't execute for real — they
  run through an honestly-labeled stand-in. The recommendation is real and
  evidence-grounded; the execution isn't, for those three. Real write access to any
  of them is a genuinely separate, bigger decision — a new privileged credential
  this environment has deliberately never had — not something I overlooked."**
- **"One of my own requirements — cutting manual cross-system correlation by
  50 to 70 percent — has its functional gap closed, but the actual percentage is
  still unmeasured. That number needs real production usage history this repo
  doesn't have yet, and I'm not going to claim a number I can't back."**
- **"There's no cost or token-usage instrumentation on the AI reasoning layer at
  all. I can tell you it calls Claude Sonnet 5. I cannot tell you what a query
  costs, because nothing logs it yet."**
- **"This runs as a single Node process with an append-only file as its audit
  store — a deliberate choice at this scale, not an oversight, but it's not what
  the target architecture in this repo's own planning docs describes for a
  higher-scale version, and I haven't built that version."**
- **"This isn't hosted anywhere. Everything you're watching right now is running
  on my own machine. Moving it somewhere reachable from outside my laptop is a
  real, deliberate next step I haven't taken."**
- **"There's a fully working MCP server in this codebase — I verified it live with
  the real MCP Inspector — but it isn't wired into anything yet. It's a proven
  capability sitting next to the app, not a connected part of it."**

> "None of these are things I discovered while writing this script. They're named
> in the architecture document itself, dated, with the real module or the real
> missing measurement next to each one. The point of naming them here first isn't
> modesty — it's that a system whose builder can tell you exactly where it stops is
> more trustworthy than one whose builder claims it doesn't."

---

## Closing — what this is actually meant to prove (15:30–16:30)

> "I didn't build this to claim a finished product. I built it to demonstrate a
> specific kind of judgment: real DBA-grade safety logic, not an AI improvising
> whether something's safe to kill. A real boundary between recommending a fix and
> executing one, crossed deliberately and narrowly, twice, only where I could
> actually prove it's safe — not everywhere at once because it looked impressive to
> say so. And an honesty discipline that runs all the way through — every claim in
> this system, and everything I've told you today, traces to a real file, a real
> commit, or a real test I actually ran, not something I'm asserting because it
> sounds right.
>
> That's the architect skill I want this to demonstrate. Not a system with no
> gaps — a system whose builder knows precisely where every one of them is."

---

## Timing checklist

| Beat | Target | What's on screen |
|---|---|---|
| Opening | 0:00–1:00 | Overview tab |
| How it works | 1:00–2:30 | Overview, or the 7-layer diagram |
| Postgres | 2:30–5:00 | Postgres incident card(s), real Troubleshoot/Fix/Approve |
| Docker | 5:00–7:00 | Docker incident card, real Troubleshoot/Fix/Approve |
| Cloud/SSIS | 7:00–9:30 | Cloud incident, Troubleshoot only (or Fix if time allows) |
| SQL | 9:30–12:00 | Two SQL cards — one safe, one refused |
| SSRS | 12:00–13:00 | An SSRS card, Troubleshoot only |
| Honest gaps | 13:00–15:30 | Talking head, or the capstone doc's Executive Summary |
| Closing | 15:30–16:30 | Talking head |

~16 minutes as scripted — trim Beat 4's optional callout and Beat 3's second check
detail first if you need to land closer to 12.

## If a beat's incident isn't currently active

Don't skip silently to a resolved one and imply it just happened — say plainly
you're triggering one live, then use the matching skill: `demo-postgres-incident`
or `demo-docker-incident` (both in `.claude/skills/`) via Claude Code, or run
`seedPostgresBlockingScenario.ts` / stop the Superset container by hand. SQL,
Cloud, and SSRS incidents come from `demo-start`'s own scheduled fault injection
and fixture data — if one isn't showing, check `demo-start` actually ran, not that
the incident needs re-triggering.

## Related

- `project-blueprint/expo/solution-architecture-capstone.html` — the document this
  script is meant to be presented alongside; its Executive Summary section is the
  written version of the "Honest gaps" beat above.
- `project-blueprint/demo-script.md` — a separate, older 90-second screencast
  voiceover script for an early, much simpler version of this app. Different
  purpose (a recorded highlight clip, not a live walkthrough) — not superseded by
  this file, just adjacent to it.
- `.claude/skills/demo-start/SKILL.md`, `demo-docker-incident/SKILL.md`,
  `demo-postgres-incident/SKILL.md` — the real setup/trigger mechanics this script
  assumes.
