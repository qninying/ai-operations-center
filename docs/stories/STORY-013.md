# STORY-013: Turn the data sources into plug-in connectors

As the engineer who will hand CoreOps to a team with its own systems, I want
each data source to be a self-contained connector that plugs in by
registration, so that adding a new system (say Oracle, or a Kafka lag feed)
means writing one new file, not editing the incident feed, the health report
and the server.

**Status:** Done (2026-10-05)
**Release:** r6 · Close the remaining requirement gaps (self-scoped, added
2026-10-05 after a requirements audit found no evidence for REQ-018)
**Owner:** Quincy Nkwain Ninying
**Blocked by:** nothing. Every source this story touches already exists and
is tested.

## The requirement this satisfies

- **REQ-018** (Constraint, must): The system must provide a plug-in connector
  architecture for extensibility.

## Why this is a real gap today

Each source follows a naming convention (`*Source.ts` reads, `*Executor.ts`
writes) with the same live/fallback contract, but nothing enforces it. Adding a
source means hand-editing `incidentFeedService.ts` (a new `discover*()` function
and a line in `tick()`), `sourceReachability.ts` (a new name), `healthCheck.ts`
and the Command Center's status map. That's a convention, not an architecture.

## How to build it

1. Define one `SourceConnector` interface in `mcp-server/src/connectors/types.ts`:
   `id`, `system` (display name), `discoverIncidents(): Promise<DashboardIncident[]>`,
   and an optional fixture fallback. Keep it read-only. Write paths
   (`*Executor.ts`) stay out of scope, because each one carries its own
   reversibility argument (ADR-012, ADR-013) and must not become generic.
2. Add a registry, `mcp-server/src/connectors/index.ts`, that exports the list of
   registered connectors. Registering a connector is the only edit outside its own file.
3. Wrap the five existing sources (SQL Server, SSRS, SSIS/cloud, PostgreSQL,
   Apache Superset) as connectors, without changing their behavior.
4. Make `incidentFeedService.ts` iterate the registry instead of calling five
   named functions. Keep `Promise.allSettled`, so one connector failing never
   hides another.
5. Record reachability and health per connector `id` from the registry, so a new
   connector appears on `/health/dependencies` and the Command Center with no
   extra edits.
6. Write ADR-016 recording the decision, the rejected alternatives (dynamic
   loading from a folder, a third-party plugin framework) and why.

## Failure paths you must handle

- A connector throws: the other connectors' incidents still appear, and the
  failure is logged with its error class (already true via `allSettled`; keep it).
- A connector hangs: each call has a timeout, so one slow system can't stall the feed.
- Two connectors register the same `id`: startup fails fast with a clear error,
  never silently dropping one.
- A connector has no fixture fallback: it reports unreachable honestly, never
  invented data.

## Acceptance: your stop condition

- [x] Given a new test-only connector added in one file plus one registry line,
      when the incident feed runs, then its incidents appear and its status shows
      on `/health/dependencies`, with zero edits to `incidentFeedService.ts`,
      `healthCheck.ts` or `sourceReachability.ts` (proven by a test).
      Verified 2026-10-05: `connectors/connectors.test.ts` registers a "kafka"
      connector through the registry seam only; the feed reveals its incident
      and `checkDependencyHealth()` reports `sources.kafka`.
- [x] Given the five existing sources migrated to connectors, when the full test
      suite runs, then every existing test still passes and production
      `/health/dependencies` reports the same sources as before.
      Verified 2026-10-05: the existing 448 tests passed unchanged against the
      migration. In production (deploy `8eae0e9`, after fixing a backstop-timeout
      regression the first deploy exposed; see ADR-016), `/health/dependencies`
      reports the same seven sources (sql, ssrs, cloud, superset, postgres, ntfy,
      flyMachinesApi), the stopped demo machines report their own
      `CircuitOpenError`, and the paging log shows `postgres:unreachable` and
      `docker:superset` raised as before.
- [x] Given one connector throws and another hangs, when the feed ticks, then
      every other connector's incidents still appear within the timeout (test).
      Verified 2026-10-05: `connectors.test.ts` (throwing, hung and healthy
      connectors; the hung one is recorded as `ConnectorTimeoutError`, and a
      second test proves its existing incidents are kept, not pruned).
- [x] Given two connectors share an `id`, when the server starts, then it fails
      fast naming the duplicate (test). Verified 2026-10-05: `validateConnectors()`
      runs when the registry module loads and throws `DuplicateConnectorError` for a
      shared `id` or `reachabilityName` (two tests in `connectors.test.ts`).
- [x] ADR-016 is written, and `docs/TRACEABILITY.md` maps REQ-018 to this story.
      Done 2026-10-05: `docs/ADR-016-plugin-connector-architecture.md`, added
      to the README's ADR table.
