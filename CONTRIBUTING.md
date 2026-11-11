# Contributing

Thanks for taking a look. This is a portfolio project, so issues and small pull requests are welcome, but large changes are best discussed in an issue first.

## Setup

Node 22. Each package installs and tests on its own:

```bash
for d in mcp-server guardrails frontend; do (cd $d && npm ci && npm test); done
```

To run the server locally, follow the [quick start](README.md#quick-start).

## Before opening a pull request

- `npx tsc --noEmit` passes in `mcp-server/` and `guardrails/`, and `npx tsc -b --noEmit` in `frontend/`.
- `npm test` passes in every package you touched, with a test for the happy path and at least one failure path for new behaviour.
- `cd mcp-server && npm run inventory:check` passes (if it fails, run `npm run inventory` and commit the result).
- No secrets, local paths or real hostnames in code, tests or commit messages.
- Every external call has an explicit timeout and capped retries; no empty `catch` blocks.

CI runs the type checks and tests on every pull request.

## Design decisions

Significant design choices are recorded as ADRs in [`docs/`](docs/). If your change alters one, update the ADR or add a new one.
