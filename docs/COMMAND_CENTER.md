# Command Center

CoreOps was built as part of the Colaberry Enterprise AI Leadership Accelerator, which tracks each project's requirements, stories and releases on its own platform. The Command Center is a static site in [`command-center/`](../command-center/) that shows that plan and what the repo contains.

**Live:** [qninying.github.io/ai-operations-center/command-center/](https://qninying.github.io/ai-operations-center/command-center/) (GitHub Pages, published from `main`).

## What it shows

- **Requirements and stories** from `.colaberry/plan.json` (the plan) and `.colaberry/progress.json` (which acceptance criteria are confirmed, and each story's verification state).
- **Repo inventory** from `command-center/data/repo-inventory.json`: AI agents, MCP tools, connected systems, and the code, test, doc and commit evidence for each requirement. It is generated from the code by `mcp-server/scripts/generateRepoInventory.mjs`.
- **Live system status** from the production `GET /health/dependencies` endpoint.

Every tab has a Sample/Real toggle. Real (the default) shows exactly what is recorded in `.colaberry/progress.json`'s `verification` block. The Colaberry platform writes that block separately from the `passed`/`evidence` fields the coding session reports (field-by-field spec: [`DATA_CONTRACT.md`](DATA_CONTRACT.md)). This repo cannot show what the platform's own verification run consists of, so it should not be described as independent human review.

## Run it locally

It reads `../.colaberry/*.json`, so serve it from the repo root, not from inside `command-center/`, and over HTTP (not `file://`):

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000/command-center/>.

## Keeping it accurate

`.github/workflows/inventory-check.yml` fails when the committed inventory no longer matches the code. To refresh it:

```bash
cd mcp-server
npm run inventory          # regenerate command-center/data/repo-inventory.json
npm run inventory:check    # what CI runs
```

## Who owns which files

| Files | Owner |
|---|---|
| `.colaberry/manifest.json`, `.colaberry/plan.json` | Written by the Colaberry platform on each sync |
| `.colaberry/progress.json` | Shared: the platform owns the story and criterion list, the repo owns the `passed` flags and notes |
| `artifacts/` (weekly programme deliverables), `docs/REQUIREMENTS.md`, `docs/STORIES.md`, `docs/TRACEABILITY.md`, `docs/DATA_CONTRACT.md`, `docs/stories/` | Synced from the platform |
| `command-center/` | This repo |
