# Live-pattern verification against Apache Superset

Not part of CoreOps's shipped product. This directory exists to answer one honest
question: *does the "try a live query, fall back to fixture data, tag the source
honestly" pattern used by `dmvReader.ts` and `ssrsReader.ts` actually work against a
real, running external system — or has it only ever been proven against mocks?*

## What this is

[Apache Superset](https://superset.apache.org/) (open source, Apache License),
running via Docker alongside a small Postgres instance for it to query against.
`verify-live-pattern.ts` authenticates against Superset's real REST API, pulls real
query-execution history (a genuine `success` row and a genuine `failed` row, each
with real timestamps and a real Postgres error message), and structures the read
exactly like `readDmv()`/`readSsrsExecutionLog()` do: live-first, tagged
`"live"` on success, falling back to fixture data and tagged `"fallback"` on any
known connection failure — never silently presenting one as the other.

## What this proves

- The live-query-then-fallback **architecture pattern** genuinely works against a
  real running system, not just against mocked HTTP/SQL calls in unit tests.
- The fallback path itself was live-tested too — stopping the Superset container
  mid-session and re-running the script confirmed a real `ECONNREFUSED` correctly
  triggers the fallback and gets tagged `"fallback"`, not an uncaught crash. (This
  caught a real bug during development: a raw connection failure throws before any
  HTTP response exists, which an earlier version of this script didn't catch.)

## What this does NOT prove

**This is not SSRS.** Superset's query-history schema (`status`, `error_message`,
`start_time`, `end_time` on its own `query` table, reached via its own REST API) is
structurally similar to SSRS's `ExecutionLog3` view in spirit, but is a different
system with a different schema and a different query language. Running this
successfully says nothing about whether `ssrsLiveSource.ts`'s actual parameterized
SQL against a real `ExecutionLog3` view is correct — that can only be validated
against real SSRS, which requires a Windows Server VM (SSRS has never shipped a
Linux or Docker distribution). See the PROGRESS.md entry for the original SSRS work
for that gap's status.

## Running it

```bash
./setup.sh                    # stands up Superset + Postgres, initializes both,
                               # runs one real successful and one real failing query
npx tsx verify-live-pattern.ts
```

Stop everything when done — this is dev/verification tooling, not meant to run
unattended:

```bash
docker compose down -v
```

`setup.sh`'s comments document two real issues hit building this, in case a future
Superset image version reintroduces either: the base image ships with **zero** SQL
Lab database drivers installed (even SQLite is explicitly blocked as a data source
"for security reasons"), and `pip install psycopg2-binary` without `--target`
silently installs to a `--user` path the venv's own Python never consults — it
looks successful but leaves the module unimportable until reinstalled with an
explicit `--target` into the venv's site-packages.
