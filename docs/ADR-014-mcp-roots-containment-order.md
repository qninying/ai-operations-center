# ADR-014: MCP Roots Containment — Resolve First, Compare Second

**Status:** Implemented — built, unit-tested against a real filesystem (including a real symlink escape and a real `../` traversal), and live-verified against the actual running server via a scripted MCP client handling a real `roots/list` exchange.
**Owner:** Quincy Nkwain Ninying
**Date:** 2026-08-31
**Component:** `mcp-server/src/security/rootsEnforcement.ts`, `mcp-server/src/diagnosticLogReader.ts`, `mcp-server/src/mcpServerFactory.ts` (`read_diagnostic_log_file`)

---

## Context

Every MCP tool registered in this gateway before today only ever performed
network I/O (SQL Server, SSRS) or nothing at all (`run_diagnostic_query`, a
stub) — none touched the local filesystem, so there was no path-containment
decision to make yet. Adding the first filesystem-touching tool
(`read_diagnostic_log_file`, reading a local diagnostic log file by path)
required deciding, before writing any tool logic, exactly how a requested
path gets checked against what the connected MCP client has declared it's
allowed to touch (MCP's `roots` capability).

The naive approach — check whether the requested path *string* starts with
an allowed root's path string — was considered and rejected before any code
was written, because it fails against two concrete, real bypasses:

1. **`../` traversal.** The raw string `"<root>/../../etc/passwd"` still
   starts with `<root>`, so a prefix check on the raw string passes, even
   though the real target is nowhere near that root.
2. **Symlink escape.** A symlink can sit physically inside an allowed root
   while its target points at a file outside every root. The raw requested
   path never mentions the symlink's real destination at all — a check on
   that raw path can't see it, because dereferencing the symlink is exactly
   the step it skips.

Both bypasses share one root cause: checking containment against the path as
*typed*, not the path as it actually *resolves* on disk.

## Decision

**Resolve the real path first. Compare second. In that order, always.**

`resolveWithinRoots()` (`security/rootsEnforcement.ts`):

1. Asks the connected client for its declared roots via a real MCP
   `roots/list` request (`server.server.listRoots()`), not a hardcoded or
   config-file list — containment is defined by what *this specific client*
   has actually declared for *this specific connection*.
2. Resolves each declared root's own real path via `fs.realpath()` — a
   declared root that doesn't exist on disk is dropped rather than trusted,
   since a typo'd or stale root can't safely widen what's allowed.
3. Resolves the *requested* path's real path via `fs.realpath()` — this is
   the step that collapses `../` segments and dereferences any symlink in
   the path, including one at the very last segment.
4. Only then compares the two real paths, with a separator-aware boundary
   check (`realTarget === realRoot || realTarget.startsWith(realRoot + sep)`)
   — not a bare `startsWith`, which would wrongly allow a sibling directory
   that merely shares a name prefix (`/allowed/root` vs `/allowed/rootxyz`).

Fails closed throughout: zero declared roots, an unresolvable declared root,
or an unresolvable requested path all deny rather than default-allow.

**Kept deliberately separate from the file-reading logic itself**
(`diagnosticLogReader.ts`), matching this repo's own established pattern of
one responsibility per module (`dmvReader.ts` vs `dmvLiveSource.ts`): this
module has no opinion about *how much* of a file is safe to read into
memory, only about *whether the path is allowed to be touched at all*. The
tool handler in `mcpServerFactory.ts` calls the containment check first,
unconditionally, before the file-reading logic ever runs.

**On denial, a clean result, not a thrown exception**: the tool handler
catches `PathOutsideRootsError`/`NoRootsDeclaredError`, logs a
`mcp_tool_denied` event (correlation ID, the literal requested path, the
error class, the reason) via the structured MCP logging capability built the
same day, and returns `isError: true` — a denial that's visible in the log
stream, not one that only shows up as an uncaught exception.

## Alternatives considered and rejected

- **Prefix check on the raw requested path string.** Rejected — this is the
  entire reason this ADR exists. It cannot see either bypass above, by
  construction, because it never resolves anything.
- **Resolve the root, but not the requested path** (compare a raw requested
  path against a resolved root). Rejected — still fully vulnerable to both
  the `../` and symlink bypasses on the requested-path side; resolving only
  one side of the comparison provides none of the real protection.
- **A hardcoded, config-file-defined allowlist of roots**, bypassing MCP's
  own `roots` protocol entirely. Rejected — MCP already has a real mechanism
  for a client to declare what it's permitting a given connection to touch;
  inventing a parallel, static mechanism duplicates that and can drift out
  of sync with what a specific client actually intends for a specific
  session.
- **Denying only on a failed `realpath()` of the requested path, without
  also validating the roots themselves.** Rejected during implementation,
  not after — an unresolvable *root* (deleted, typo'd, moved) would
  otherwise never be dropped, and a `startsWith()` comparison against a
  garbage root path is undefined behavior, not a safe deny.

## Consequences

**What this proves, live, not just in a unit test:** a scripted MCP client
declared exactly one real root (`sample-logs/`), and three real calls
against the actual running server confirmed the design end to end — a
legitimate file inside the root read successfully; a `../../../etc/hosts`
traversal attempt was denied; a real `fs.symlink()` created physically
inside the declared root, pointing at a file in a second, undeclared
directory, was also denied. All three matched the unit-tested behavior
exactly, closing the gap between "the logic is correct in isolation" and
"the wired-together system behaves correctly against a real client."

**What this still doesn't cover:** only `read_diagnostic_log_file` uses this
guard, because it's the only tool that touches the filesystem at all today.
The guard was built as reusable infrastructure specifically so the next
filesystem-touching tool doesn't have to re-derive this reasoning — it just
calls `resolveWithinRoots()` first, the same way this one does.

## What would change this decision

A future filesystem-touching tool that needs to *write*, not just read,
would need its own additional safety layer on top of this one (evidence
linkage, human approval, the same pattern `remediationGuardrail.ts` already
applies to production writes elsewhere in this codebase) — containment
alone answers "is this path allowed to be touched," not "is writing to it
safe." This ADR's scope is read-path containment only, deliberately.
