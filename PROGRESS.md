# PROGRESS.md

Per-change engineering log: each completed change, with the session that made it and the evidence it was verified. Entries before 2026-11-10 (about 600 KB) are in [`docs/archive/PROGRESS-full.md`](docs/archive/PROGRESS-full.md). Milestones are summarized in [`CHANGELOG.md`](CHANGELOG.md).

Older notes in the code and docs that say "see the PROGRESS.md entry" refer to the archive.

## Portfolio cleanup

- [x] Portfolio cleanup: archive the full progress log and add a milestone changelog
  - Date: 2026-11-10
  - Session: CC-20261110-2u8d
  - What changed: Moved the 612 KB log to `docs/archive/PROGRESS-full.md` (`git mv`, history preserved), started this short `PROGRESS.md` (kept at the root because the commit hook requires a root `PROGRESS.md` in every commit), and added `CHANGELOG.md` with milestones by month.
  - Verification: `git log --follow docs/archive/PROGRESS-full.md` shows the full history. Every `CHANGELOG.md` ADR link checked to resolve to an existing file. No code, workflow, Docker or Pages path reads `PROGRESS.md` (`git grep`: only prose comments).

- [x] Portfolio cleanup: fix relative links in docs/process/skills.md after the move
  - Date: 2026-11-10
  - Session: CC-20261110-2u8d
  - What changed: Five `](project-blueprint/...)` links in `docs/process/skills.md` now use `../../project-blueprint/`.
  - Verification: A link checker over every tracked `.md`/`.html` file (scratchpad `linkcheck.py`, run against `main` and against this branch's HEAD, diffing the two) reports zero new broken links after this fix.

