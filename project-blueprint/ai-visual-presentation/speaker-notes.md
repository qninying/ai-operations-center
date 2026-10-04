# Speaker notes: CoreOps AI Visual Presentation

Never shown to the audience. Paired with `presentation.html` (open it full screen,
keep this file on a second screen or printed).

**Audience:** Architect Demo Panel. **Purpose:** understand what I built clearly.
**Speaking time:** 5:00, Q&A separate, 2:00.
**Owner / Visual style / Theme / Presenters and handoffs:** not supplied for this
exercise, so a plain, high-contrast, single-presenter dark deck was used by default.

Total speaking budget: 40 + 60 + 70 + 80 + 50 = 300s (5:00) exactly. The timer in
the deck's chrome (press **Start** before you begin) counts up from 00:00; glance
at it, don't stare at it.

---

## Slide 1: The problem, shown (0:00-0:40)

**Say:** "This is a real screenshot from CoreOps's production dashboard, October
1st. Two different incidents, two different systems, SSIS and SSRS, and they
both failed with the exact same error: the AI recommendation feature couldn't
reach Anthropic's API. A 401, invalid key."

**Pause. Let them read the error block, it's real, verbatim.**

**Say:** "Here's the part that matters: the health check for this app reported
`anthropic.configured: true` the entire time. Not degraded, not warning, true.
Because 'configured' only ever checked whether the API key environment variable
was a non-empty string. Never whether the key actually worked."

**Transition:** "That gap, and how I closed it, is a good way into how this whole
system actually thinks about truth versus appearance, which is the real subject
of this talk."

**Pronunciation / terms:** "SSIS" = S-S-I-S (letters). "SSRS" = S-S-R-S (letters).
"Anthropic" = an-THROP-ik.

---

## Slide 2: Before and after (0:40-1:40)

**Say:** "Same task on both sides: diagnosing a real incident. On the left, the
manual version: notice something's wrong, SSH in, grep logs, guess, fix blind,
hope. Eight steps."

**Point left to right, don't read the list aloud verbatim, they can read it.**

**Say:** "On the right, the same task with CoreOps. Three steps. Five of the old
ones are gone: SSH access, manual log queries, manually deciding the fix by
hand, manually re-checking, manually writing it up. One step is genuinely new,
not just automated: Troubleshoot, an AI-generated root cause that cites the exact
evidence rows it used."

**Transition:** "Let me show you that middle step, the one step a human still
owns in this whole loop."

---

## Slide 3: How the workflow runs (1:40-2:50)

**Say:** "Every three seconds, CoreOps polls five real sources: SQL Server,
SSRS, a cloud blob, Superset, Postgres, for a genuine problem, not a simulated
one. When it finds one, it proposes a root cause. Then it stops."

**Point directly at the gold-bordered Approve box.**

**Say:** "Nothing executes past this point without a human clicking Approve.
That's the one control point in the whole chain; everything before it is
detection and reasoning, everything after it is automatic: real execution, a
confirmed health check, and an audit log entry, every time."

**Transition:** "I'm not going to tell you that worked, I'm going to show you
the actual log."

**Pronunciation:** "ADR" = A-D-R (letters, "architecture decision record").

---

## Slide 4: Evidence (2:50-4:10)

**Say:** "These are two real lines, copied exactly, from `fly logs` against the
live production instance. Left: the moment a real incident, Superset, stopped,
was detected. Right: the moment it cleared, after a real restart, confirmed
healthy."

**Let the elapsed-time line land before speaking over it.**

**Say:** "Forty-four point three seconds, detection to confirmed recovery. I want
to be precise about what that number is: one measured test run, October 3rd. Not
an average across many runs, not a guarantee. If you ask me for an SLA right now,
the honest answer is I don't have one yet; I have one real number."

**Transition:** "Which is exactly why the next slide is a question, not a win."

---

## Slide 5: The next step (4:10-5:00)

**Say:** "STORY-012 has one acceptance criterion still unchecked: a different
engineer, with no help from me, following the deployment runbook alone, and
succeeding. I haven't tested that. Self-review isn't the same thing."

**Say:** "What would actually settle it is handing the doc to someone who's never
seen this repo and watching where it breaks. That's the next decision, not a
technical one, a 'who and when' one."

**Stop talking. Let the slide sit for the last few seconds. Do not add a summary
slide or a closing line: the five-minute budget ends here.**

---

## General delivery notes

- Don't narrate bullet lists word-for-word: the panel reads faster than you
  talk. Narrate the *reasoning* the image doesn't show.
- If a slide needs more than ~5 seconds to parse on its own, that's a sign to
  cut something from it later, not to slow down your delivery to compensate.
- Q&A is separate (2 min) , if a panelist jumps in early, it's fine to say "happy
  to take that in Q&A" and keep the 5:00 clock intact.
