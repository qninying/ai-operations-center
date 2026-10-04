# Rehearsal checklist: CoreOps AI Visual Presentation

## The sound-off drill (do this at least once)

Play `presentation.html` with the sound off. Time how long each slide takes to
understand with zero narration. Any slide over ~5 seconds to decode is doing
your talking for you, go back and cut it, don't plan to talk faster to
compensate.

| Slide | Target decode time | Your measured time | Cut needed? |
|---|---|---|---|
| 1. The problem, shown | under 5s | | |
| 2. Before and after | under 5s | | |
| 3. How the workflow runs | under 5s | | |
| 4. Evidence | under 5s | | |
| 5. The next step | under 5s | | |

## Checklist you will be held to

- [ ] Every slide makes one point, and its title says what that point is.
- [ ] Someone could follow the argument with the sound off (verified by the
      drill above, not assumed).
- [ ] No slide asks the audience to read while you are talking over it.
- [ ] Every number on screen is either sourced or labelled as an estimate.
      (This deck has exactly one number, 44.3 seconds on Slide 4, and it is
      explicitly labelled as one measured test run, not an average or an SLA.)
- [ ] Your before-and-after is the same task, not two different tasks.
      (Both sides of Slide 2 are "diagnosing a real incident.")

## Five likely panel questions, with grounded answers

**1. "Why doesn't the health check just call Anthropic directly to verify the
key works?"**
Because that would mean a real, billed Anthropic API call on every single
health-check poll, recurring spend against `CLAUDE_API_CALL_BUDGET` just to
answer a question this app already answers for free. `anthropicReachability.ts`
instead records the outcome of the two real call sites (`rootCauseAgent.ts`,
`diagnosticsGatherer.ts`) and `healthCheck.ts` reads that back. No new call, no
new spend.

**2. "What exactly can a human not override or skip in this workflow?"**
The Approve step. Every proposed action goes through the same
`POST /api/guardrail/decide` path regardless of source, and execution only
happens after that explicit approval (ADR-010). There is no "auto-approve"
setting for production-affecting actions in this system.

**3. "Is the 44.3-second number typical, or cherry-picked?"**
*Needs the learner's own input before the panel.* Honest grounded answer: it
is one real, measured test run from 2026-10-03, not an average across many
runs and not a benchmarked or guaranteed figure. If pressed for a typical
range, say plainly that one data point is not enough to state one, rather
than estimating a range that isn't backed by measurement.

**4. "What happens if Approve is clicked but the real restart fails?"**
A real, visible failure (`DOCKER_RESTART_FAILED` in the audit log and the
dashboard), never a silent fallback to a fake "fixed" state. Per ADR-012,
execution and confirmation are two separate steps specifically so a restart
is never reported resolved until independently confirmed healthy.

**5. "Why do only Docker and Postgres get real execution, and not SQL Server
or IIS?"**
Per ADR-012's own alternatives-considered section: Docker/Postgres are the one
target already under direct, unprivileged, reversible control, a local/sidecar
container restart needs no new credential. Real SQL Server or IIS write access
would each require a genuinely new privileged connection this system has
deliberately never had, a separate, deliberate decision, not bundled into this
one.

## Shortened run order, if time is cut

If you only get 2-3 minutes instead of 5:

1. **Skip Slide 1 entirely** (or show it silently for 5s while you say one
   sentence: "AI recommendations failed silently in production once, here's
   why, and here's the system that replaced manual response to failures like
   that").
2. **Slide 3 (workflow) and Slide 4 (evidence) are the two that must survive a
   cut**, they carry the actual demonstration and the human-control story,
   which are the two highest-weighted criteria (25% and 15%).
3. Compress Slide 2 to one spoken line: "eight manual steps became three, one
   of them new."
4. Slide 5 (next step) can be cut to the single sentence in the `<p class="q">`
   without the "what would settle it" line, if seconds are truly tight.

## Reflection to end on

**Which slide were you tempted to add words to, and what does that tell you
about the image?**

*Left for the learner to answer after rehearsing*, this is a self-reflection
question about your own deck, not something answerable from the project
material alone. A genuine answer names the specific slide and the specific
temptation (usually: wanting to add a sentence that restates what the image
already shows), which is itself the signal that the image isn't carrying the
point on its own yet.
