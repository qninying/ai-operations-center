# STORY-014: Measure whether CoreOps actually cuts manual correlation time

As the person asking an ops team to trust CoreOps, I want a measured answer to
"does it save the time it promises", taken against the team's own recorded
baseline, so that the 50-70% target in REQ-017 is either shown or honestly
shown not to hold.

**Status:** Planned
**Release:** r6 · Close the remaining requirement gaps (self-scoped, added
2026-10-05; REQ-017's capability is built, but its target has never been measured)
**Owner:** Quincy Nkwain Ninying
**Blocked by:** access to a real team's troubleshooting tickets for a trial
period. This can't be measured on demo data, because the baseline is real
people's logged time.

## The requirement this satisfies

- **REQ-017** (Non-functional, should): The system must reduce manual incident
  correlation across systems by 50-70%.

## The baseline

About 20 hours a week spent troubleshooting, from JIRA time logged on
troubleshooting tickets (the user's own data, 2026-10-03). Before starting,
write down which team, which ticket categories and which weeks that figure
covers. The trial must compare like with like.

## How to build it

1. **Agree the target and method in writing before collecting any data**, with
   the team that owns the systems. What counts as "correlation time", which
   ticket categories, and how long the trial runs. Fixing this up front is what
   stops the goalposts moving afterwards.
2. **Derive CoreOps-side timings from the audit trail**, not from memory. Add a
   read-only script, `mcp-server/scripts/measureCorrelationTime.mjs`, that pairs
   each incident's detection with its first human decision (the `hitl_enqueued`
   and `hitl_decision` entries already share a correlation ID) and reports
   per-incident and weekly totals.
3. **Bring the trial-period JIRA time in as an exported CSV** first (key,
   category, minutes logged), so no Jira API access or token is needed to start.
   Swap in the Jira API later if the team approves it.
4. **Write the result up** as `docs/MEASUREMENT-001.md`, in the same style as
   INCIDENT-DRILL-001: method, raw numbers, result and limits.
5. **Show it on the Command Center's Outcomes tab** as measured, with its date
   and sample size, replacing "not measured yet".

## Failure paths you must handle

- Too few incidents in the trial: report the sample size and say the result is
  inconclusive, rather than extrapolating.
- Baseline and trial cover different ticket mixes: report it as a limit, and
  don't adjust the numbers to compensate.
- Audit entries with a missing decision (abandoned or escalated incidents):
  count them separately, never drop them silently.
- The target isn't met: that is a valid result. Publish it with what would need
  to change.

## Acceptance: your stop condition

- [ ] The target, method, ticket categories and trial period are agreed and
      written down before any trial data is collected.
- [ ] `measureCorrelationTime.mjs` computes detection-to-decision times from a
      real audit trail, with tests for paired, unpaired and empty-trail cases.
- [ ] `docs/MEASUREMENT-001.md` reports the baseline, the trial result, the
      sample size and the limits, with raw numbers.
- [ ] The Outcomes tab shows the measured result with its date, labelled
      measured, or "inconclusive" if the sample is too small.
