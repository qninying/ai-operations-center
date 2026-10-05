# ADR-016: A Plug-in Connector Architecture for Data Sources

**Status:** Implemented. Built, tested, and the five existing sources migrated with no behavior change.
**Owner:** Quincy Nkwain Ninying
**Date:** 2026-10-05
**Component:** `mcp-server/src/connectors/` (`types.ts`, `index.ts`, `sourceCheck.ts`, five `*Connector.ts`), `incidentFeedService.ts`, `sourceReachability.ts`, `healthCheck.ts`, `mcp-server/scripts/generateRepoInventory.mjs`, `command-center/systems.html`
**Satisfies:** REQ-018 (Constraint, must), via STORY-013

---

## Context

REQ-018 says the system must provide a plug-in connector architecture for
extensibility. A requirements audit on 2026-10-05 found no evidence for it: no
code, test, doc or commit named it.

There was a convention. Each source lived in a `*Source.ts` file with the same
live/fallback contract. But nothing enforced the convention, and adding a source
meant hand-editing four places:

1. `incidentFeedService.ts`: a new `discover*Incidents()` function, a new entry
   in `tick()`'s `Promise.allSettled([...])`, and the parallel `SOURCES` array,
   which had to stay index-aligned with it by hand.
2. `sourceReachability.ts`: a new name in the fixed `ReachabilitySource` union
   and `ALL_SOURCES` list.
3. `healthCheck.ts`, indirectly through that fixed list.
4. The Command Center's Systems status map.

That's a convention that happens to work, not an architecture. The index-aligned
`SOURCES` array was also a latent bug: reordering one list without the other
would silently attribute "checked, all clear" to the wrong source and prune its
real incidents.

## Decision

**One read-only `SourceConnector` interface, one registry, and everything else
reads the registry.**

- `connectors/types.ts` defines `SourceConnector`: `id`, `system`,
  `reachabilityName`, and `discoverIncidents()`. That method resolves `[]` when
  the source is checked and clear, and rejects when it couldn't be checked. That
  distinction is what keeps a transient outage from pruning real incidents.
- `connectors/index.ts` holds the `REGISTERED` list. **Adding a source = one new
  connector file + one line in that list.** Nothing else is edited.
- The incident feed iterates the registry. Each connector runs through
  `discoverWithTimeout()` (10s backstop above each source's own timeouts), and a
  hung connector is recorded as a failed check (`ConnectorTimeoutError`). It's
  never treated as "clear", so its existing incidents are kept.
- `GET /health/dependencies` reports every registered connector's
  `reachabilityName`, plus ntfy and Fly's API.
- `validateConnectors()` fails fast at startup if two connectors share an `id` or
  a `reachabilityName`, instead of letting one silently shadow the other.
- The shared `sourceCheck.ts` helpers log every check the same way, keeping the
  historical `source` field so existing log queries still work, and record its
  outcome for live status.
- The repo inventory (`npm run inventory`) reads the registry, so the Command
  Center's Systems tab lists each connector and gives it a live status
  automatically.

**Deliberately read-only.** Write paths (`*Executor.ts`) are not connectors. Each
real write carries its own reversibility and blast-radius argument (ADR-012,
ADR-013) and a guardrail review. Making writes pluggable would let a new file add
a production write path without that review. That is exactly the boundary this
system exists to hold.

## Alternatives considered and rejected

- **Dynamic loading (scan a `connectors/` folder at startup and import whatever is
  there).** Rejected: a file appearing on disk would silently start running in
  production. An explicit registry line is a reviewable diff, and a stray or
  half-finished file can't go live by accident.
- **A third-party plugin framework.** Rejected: a new dependency and its supply-chain
  surface for five sources and a ~20-line contract. The repo's rule is no drive-by
  dependencies.
- **Keep the convention and document it.** Rejected: REQ-018 is a *must*, and an
  unenforced convention is how the index-aligned `SOURCES` array became a latent
  bug in the first place.
- **Make executors pluggable too.** Rejected, see "Deliberately read-only" above.

## Consequences

- `incidentFeedService.ts` shrank from 418 to about 200 lines. Source-specific
  logic now lives next to the source.
- `IncidentSource` and `ReachabilitySource` are plain strings instead of fixed
  unions, so the type system no longer catches a misspelled source id. The
  duplicate-id check and the registry tests are the replacement guard.
- The Superset connector keeps `id: "docker"` (its historical dashboard name), so
  existing incident ids like `docker:superset` and the dashboard's handling are
  unchanged. Its `reachabilityName` is the real name, `superset`.
- Verified: the existing 448 tests passed unchanged after the migration, plus new
  acceptance tests in `connectors/connectors.test.ts` and registry-parsing tests
  in `generateRepoInventory.test.ts`.

## What would change this decision

If a write path ever needs to be added by teams who don't own this codebase, the
answer is still not pluggable executors. It's a review process with a new ADR per
write path, the way ADR-012 and ADR-013 were done.
