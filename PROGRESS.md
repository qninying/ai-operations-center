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
  - What changed: Five relative links to project-blueprint files in `docs/process/skills.md` now climb two levels (`../../project-blueprint/`).
  - Verification: A link checker over every tracked `.md`/`.html` file (scratchpad `linkcheck.py`, run against `main` and against this branch's HEAD, diffing the two) reports zero new broken links after this fix.

- [x] Portfolio cleanup: keep the archived progress log out of requirement evidence
  - Date: 2026-11-10
  - Session: CC-20261110-2u8d
  - What changed: `requirementEvidence()` in `mcp-server/scripts/repoRequirements.mjs` now skips `docs/archive/`. Without it, moving the log under `docs/` made it count as documentation evidence for 24 requirement references and flipped one requirement from `no_evidence` to `documented_only` on the public Command Center. At the root it was never scanned, so this restores the previous output exactly.
  - Verification: New test `archived change logs under docs/archive/ are not counted as documentation evidence` fails without the fix (1 failed, 17 passed) and passes with it (18/18). `node mcp-server/scripts/generateRepoInventory.mjs --check` passes again, so the committed `repo-inventory.json` is unchanged from `main`.

- [x] Portfolio cleanup: move feature detail and Command Center docs out of the README
  - Date: 2026-11-10
  - Session: CC-20261110-2u8d
  - What changed: Added `docs/FEATURES.md` (the README's long "What's real" detail, regrouped as governance and security, audit trail, AI reasoning, reliability, operations, interfaces, with code paths and ADR links) and `docs/COMMAND_CENTER.md` (what the Command Center shows, the live Pages URL, how to run it locally, and which files the Colaberry platform owns).
  - Verification: Every code path named in `FEATURES.md` checked to exist with a shell loop (one fix: `dashboard.html` is `mcp-server/src/dashboard.html`); the Command Center's data paths read from its source (`../.colaberry/*.json`, `data/repo-inventory.json`), which is why it must be served from the repo root; `https://qninying.github.io/ai-operations-center/command-center/` returned 200 (the old README's instruction to open the repo root gives a 404 on Pages).

- [x] Portfolio cleanup: rewrite the README for a 60-second reader
  - Date: 2026-11-10
  - Session: CC-20261110-2u8d
  - What changed: New README structure: one-sentence pitch, badges (deploy, license, Node), TL;DR (what it is, role, stack, results, live links), demo section with a GIF placeholder and the no-login `curl` check, grouped one-line features with ADR links, both diagrams and a condensed ADR table, a copy-paste quick start, test counts from a fresh run, a "My contribution and AI usage" section with TODOs, status and roadmap, and a repository layout table that explains `.colaberry/`, `artifacts/` and `.claude/`. Internal story and requirement codes removed. Added `docs/media/SHOT_LIST.md` for recording the demo GIF.
  - Verification: Quick start run verbatim in a fresh clone of this branch under Node 22: `npm ci` succeeded, the generated `.env` held the 3 required values, `npm run http` started, `/health` returned 200 and `/login` returned 200 (the old quick start omitted the required `AUTH_USERNAME`). Test counts are from this session's full run (465 + 70 + 6 = 541). Shot-list button labels (Troubleshoot, Fix, Approve, View audit trail) checked against `mcp-server/src/dashboard.html`. "Stand-in" wording for SQL Server/SSRS/SSIS/IIS/cloud execution checked against ADR-012. No em dashes in any new or rewritten doc.

- [x] Portfolio cleanup: add a CI workflow for type checks and tests
  - Date: 2026-11-10
  - Session: CC-20261110-2u8d
  - What changed: Added `.github/workflows/ci.yml`: on every push and pull request, a 3-job matrix (`mcp-server`, `guardrails`, `frontend`) on Node 22 with npm caching runs `npm ci`, the type check (`tsc --noEmit`, or `tsc -b --noEmit` for the frontend) and `npm test`. Read-only token permissions, 15-minute timeout, superseded runs cancelled. Added the CI badge to the README.
  - Verification: `act` is not installed, so each matrix job was reproduced in its own fresh shallow clone of this branch (`git clone --depth 1`, matching CI's default checkout) under Node 22 with the job's exact commands: all three `npm ci` exit 0, all three type checks exit 0, tests 465/465, 70/70 and 6/6. The guardrails clone had no `mcp-server/node_modules`, confirming the jobs do not depend on each other. YAML parsed with Ruby `YAML.load_file`. Not yet run on GitHub (nothing pushed).

- [x] Portfolio cleanup: skip the Claude code review on Dependabot pull requests
  - Date: 2026-11-10
  - Session: CC-20261110-2u8d
  - What changed: `claude-code-review.yml`'s `review` job now has `if: github.actor != 'dependabot[bot]'`.
  - Verification: Root cause from the failed run log of Dependabot PR #15 (`gh run view --log-failed`): "Secret source: Dependabot", so the Anthropic key is unavailable and the review fails on every dependency bump (all 5 open Dependabot PRs show `review: FAILURE`). Workflow YAML parsed with Ruby `YAML.load_file` and the `if` read back. Takes effect on GitHub after merge.

- [x] Portfolio cleanup: bump setup-node to v7 in the inventory check
  - Date: 2026-11-10
  - Session: CC-20261110-2u8d
  - What changed: `inventory-check.yml` now uses `actions/setup-node@v7`, matching `ci.yml` and Dependabot PR #6 (which only bumps `deploy.yml`; `inventory-check.yml` was added after that PR was opened).
  - Verification: setup-node v7.0.0 release notes (from the PR #6 body) list only new cache outputs, a removed dummy `NODE_AUTH_TOKEN` export and a cache library update; this workflow uses none of the changed inputs (`node-version` only). YAML parsed with Ruby.

