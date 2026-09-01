# Transport Decision Record — CoreOps MCP Server

**Component:** `mcp-server/` (the MCP Tool Gateway)
**Owner:** Quincy Nkwain Ninying
**Date:** 2026-08-31

This is a plain-language walkthrough of the transport decision, worked through
question by question rather than starting from a conclusion. It arrives at, and
confirms, the same choice already made and implemented in
[ADR-001](ADR-001-mcp-transport-selection.md) — see that document for the
deeper architectural context (deployment topology, Kubernetes scaling drivers).
This one exists as the shorter, reasoning-first version of the same answer.

---

## The five questions

**1. Who calls this server, and from where?**
> In the future it will be something reachable over the public internet.

**2. How many people or processes call it at the same time, realistically?**
> A handful at once, maybe a dozen.

**3. Does it need to run on more than one machine, now or within a year?**
> Not for now — but if a client ends up wanting this implemented in their own
> environment, then it will be more than one machine.

**4. Does anything about it have to survive between requests?**
> No — every call stands alone.

**5. What is the worst thing that happens if it's unavailable for an hour?**
> The team won't be able to see what's broken. That can lead to reports not
> showing live data, or a stuck stored procedure blocking other processes
> without anyone noticing. (Illustrative example, not an exhaustive list.)

---

## Decision

**Transport:** StreamableHTTP
**State model:** Stateless (no session affinity — any request can be served
without depending on state left behind by an earlier one)

## Rationale

**Transport, from Q1.** The server needs to be reachable over the public
internet — a caller on a different machine entirely, not a process spawned
locally. That rules out stdio outright: stdio is a same-machine parent-child
pipe, not a network protocol. StreamableHTTP is the transport that's actually
reachable across that gap.

**Statelessness, from Q4 and Q3.** Every call already stands alone (Q4) — there
is nothing a session would actually be preserving, so paying for session
management would be solving a problem that doesn't exist yet. And precisely
because Q3 leaves open a real possibility (a client wanting this running in
their own environment, which means more than one machine), stateless keeps
that door open for free: any instance can answer any request, with no
instance-specific state to reconcile or lose. Q2's modest concurrency (a
dozen or so at once) doesn't push toward anything more elaborate than this
either way.

This matches what `mcp-server/src/httpMcpServer.ts` already runs today
(`StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`) — this
exercise arrived at the same place `httpMcpServer.ts` and ADR-001 already
did, independently, from the answers above rather than from reading the code
first.

## Rejected option

**STDIO.** The reason isn't that stdio only supports a single user — the
number of users a caller has has nothing to do with it. Stdio is a
same-machine parent-child pipe: it structurally cannot be reached from
another machine over a network at all, no matter how many or how few callers
there are. Even one remote caller could not reach an stdio server across the
internet. The real disqualifier is Q1 alone: this server needs to be
reachable over the public internet, and stdio cannot do that, full stop.

(`mcp-server/src/index.ts` still runs stdio today — correctly kept as the
local, zero-config dev entry point per ADR-001, not as a candidate for the
deployed, network-reachable path this record is about.)

## Condition that would trigger a revisit

If a client wants this deployed inside their own environment (Q3's real,
named scenario), this server would need to run on more than one machine —
worth revisiting at that point, though the stateless model chosen here is
already built to make that a scaling exercise, not a redesign.
