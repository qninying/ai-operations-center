<!-- COLABERRY:BEGIN — managed by the build pipeline. Edits inside this block are overwritten. -->
# CLAUDE.md — CoreOps AI Operations Dashboard

Conventions for this build. Claude Code reads this automatically.

## What this is

An enterprise-grade AI Operations Dashboard for SQL Server, SSIS, SSRS, and Windows servers, providing intelligent command center capabilities with human approval for production changes.

## Where the truth lives

- `docs/REQUIREMENTS.md` — what the system must do
- `docs/STORIES.md` — the work, by release
- `docs/stories/STORY-nnn.md` — one story in full, with its acceptance criteria
- `docs/TRACEABILITY.md` — which story covers which requirement

Read the requirement before writing code for a story. If the requirement is wrong,
fix the requirement — you are the architect here, not a typist.

## How we build

- **Walking skeleton first.** Get the thinnest end-to-end path working, including the
  audit trail and whatever correctness guarantee this system promises, before stacking features.
- **Small, reversible steps.** A change you cannot undo in one command is too big.
- **Every external call gets an explicit timeout and capped retries.** No unbounded waits.
- **Every side effect is idempotent.** Running it twice must not double-charge, double-email,
  or double-create. If a retry can produce a duplicate, it is broken.
- **Never swallow an error.** An empty `catch` block is a defect, not tidiness.

## Definition of done

A story is done when **every** acceptance criterion on it passes **and** a commit
names it. Both halves. All of the criteria, not the important ones; and the work in
git, not just ticked off.

1. Tests cover the happy path **and** at least one failure path.
2. No secrets in code, commits, or logs.
3. Every acceptance criterion in `docs/stories/STORY-nnn.md` genuinely passes.

## When you finish a story

Two steps, in this order. The platform reads both — skip either and the story stays
unverified, and it will tell you which half is missing.

1. Update `.colaberry/progress.json`: find the story by `id`, set `passed` on each
   criterion to what is actually true, and fill in `files_touched` and `tests_added`.
   Leave the ones that do not pass as `false` — a partly finished story is a real,
   expected state and reports honestly. Do not add criteria of your own: only the ones
   from the plan are counted, and invented ones are discarded.
2. Commit, naming the story in a trailer, e.g. `STORY-001: add the roster endpoint`
   with `Story: STORY-001` on its own line below. The commit must change at least one
   file. Then push — the platform reads pushed commits, not your working tree.

## This repo

https://github.com/qninying/ai-operations-center

## The `.colaberry/` files

These three files are what your Command Center reads, so they have to be in your repo.

- `.colaberry/plan.json` — your requirements, stories and releases.
- `.colaberry/progress.json` — the criteria and which of them you have confirmed.
- `.colaberry/manifest.json` — when the data above was last refreshed.

Where the platform has push access to this repo it writes all three for you on every
sync, and it will overwrite `plan.json` and `manifest.json` when it does — so edit those
two only if you are maintaining them yourself. **Where it does not have push access it
cannot put them there at all**, and they are yours to add: download them from the
workspace panel in the portal and commit them like any other file. Either way, a
criterion that names one of these files is not satisfied until the file is really in
your repo.

`.colaberry/progress.json` is shared in both cases: the platform owns the story and
criterion list in it, you own the `passed` flags and the notes, and a sync keeps your
side. Everything else — including the docs above — is yours to change.
<!-- COLABERRY:END -->
