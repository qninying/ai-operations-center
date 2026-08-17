# ADR-001: Transport Selection for the MCP Tool Gateway

**Status:** Proposed — needs DRI sign-off before the target-state column below is implemented.
**Owner:** Quincy Nkwain Ninying
**Date:** 2026-08-12
**Component:** `mcp-server/` (the MCP Tool Gateway, per `architecture.md`)

---

## Context

The MCP Tool Gateway is the one component every AI agent uses to reach monitored
platforms (SQL Server today; SSIS, SSRS, and Windows Servers per the target design in
`architecture.md`), read-only by default with a separate, gated write path only the
Execution Service may call.

Two things are already true in this codebase and don't need re-deciding:

1. **Current implementation (R2):** `mcp-server/src/index.ts` speaks real MCP over
   **stdio only**. `mcp-server/src/httpServer.ts` is a separate, bespoke HTTP/JSON API
   for the demo dashboard — it does not carry the MCP protocol, so it isn't a
   competing transport option, just a different surface.
2. **Target deployment topology (`architecture.md`, "Deployment topology"):** the MCP
   Tool Gateway runs close to the monitored platforms (on-prem or in the same VNet),
   while the AI agents that call it (Root Cause Analysis Agent, Impact & Remediation
   Agent) and the Execution Service run centrally in a Kubernetes namespace, **scaled
   independently** because telemetry volume, correlation load, and AI agent
   concurrency all grow at different rates.

This ADR decides which MCP transport the Tool Gateway should run in **that target
topology** — not whether to keep stdio available at all (see Decision, below).

## Decision drivers

Pulled directly from the project's own stated requirements, not generic transport
tradeoffs:

| Driver | Source | Why it matters here |
|---|---|---|
| Cross-host reachability | `architecture.md` deployment topology | The Tool Gateway and its callers run on different hosts/pods by design. A transport that requires the client to spawn the server as a local subprocess cannot satisfy this. |
| Independent horizontal scaling | `architecture.md`: "scaled independently... AI agent concurrency" | If the RCA Agent or Execution Service scale to multiple replicas, each replica needs to reach the *same* running Gateway concurrently — not get its own private subprocess. |
| Concurrent request handling during incident bursts | `architecture.md`: Correlation Engine groups near-simultaneous failures into one incident | A real incident can trigger several diagnostic queries in flight at once (RCA Agent reads, later an Execution Service write). This is inherently concurrent, not one request at a time. |
| Least-privilege, auditable access per caller | `architecture.md` security notes: separate read-only vs. write-scoped service accounts, "MCP" → Audit Log Store edge | Once the Gateway is reachable over a network rather than trusted by process ancestry, it needs real authentication per caller, not the implicit trust a spawned child process gets for free. |
| Local development ergonomics | Current R2 workflow | An engineer (or Claude Desktop / MCP Inspector) connecting directly to the Gateway for debugging shouldn't need a running network service, TLS, or auth just to poke at `read_sql_server_dmv`. |

## Options considered

| | **STDIO** | **StreamableHTTP** | **SSE (legacy HTTP)** |
|---|---|---|---|
| Transport model | Subprocess, stdin/stdout | Persistent HTTP server, resumable connections | HTTP server, one-way server push + separate POST channel |
| Cross-host reachability | ❌ No — client must spawn the server locally | ✅ Yes — standard HTTP, any network-reachable client | ✅ Yes |
| Multiple independent concurrent clients | ❌ No — one server process per one spawning client | ✅ Yes — the SDK supports `stateless_http=True` for exactly this (no session pinned to one server process) | ⚠️ Partial — supported, but the SDK and spec both treat this as the predecessor to StreamableHTTP |
| Fits "agents scale independently" | ❌ No | ✅ Yes — a Kubernetes Service in front of multiple Gateway replicas works normally | ✅ Yes, with more operational complexity |
| Authentication / auth per caller | N/A (process-boundary trust) | ✅ Built into the SDK (`auth_server_provider`, `token_verifier`, `AuthSettings`) | ⚠️ Supported, but the ecosystem is consolidating on StreamableHTTP |
| Local dev / Claude Desktop / Inspector ergonomics | ✅ Zero config, matches today's `npm run dev` | ⚠️ Requires the client to know a host:port and (once auth is wired) a credential | ⚠️ Same as StreamableHTTP |
| Current implementation status in this repo | ✅ Already built (`index.ts`) | ❌ Not yet built — `httpServer.ts` is a bespoke REST shim, not this | ❌ Not used |

SSE is included for completeness but isn't a serious contender: it solves the same
problem StreamableHTTP does, with more moving parts (two channels instead of one) and
is the transport the MCP spec itself is moving away from. It's not carried forward as
an option below.

## Decision

**Run two transports, for two different consumers, not one transport for everything:**

1. **StreamableHTTP is the transport for the deployed Tool Gateway** that AI agents,
   the Execution Service, and anything else running in the central Kubernetes
   namespace connect to. This is the only option that satisfies cross-host
   reachability and independent scaling, which are both already committed to in
   `architecture.md` — this ADR doesn't introduce that requirement, it just picks the
   transport that can actually deliver it.
2. **STDIO remains available as a local, dev-only entry point** — unchanged from
   today's `index.ts` — for an engineer or Claude Desktop connecting directly to a
   Gateway instance running on their own machine. This is not "supporting two
   production transports"; it's keeping the zero-config debugging path that already
   works, alongside the network path that production actually needs.

This is a **change from the current state**, where stdio is the only real MCP
transport implemented. It does **not** ratify `httpServer.ts` as-is: that file is a
custom REST API, not an MCP transport, and doesn't satisfy "agents speak MCP to the
Gateway" — it satisfies "the demo dashboard has something to call." Whether to keep,
retire, or fold `httpServer.ts`'s dashboard routes in alongside a real StreamableHTTP
MCP endpoint is a separate, smaller decision, not part of this ADR.

## Consequences

**What this requires, if approved:**
- Add a StreamableHTTP transport path in `mcp-server/src/index.ts` (or a sibling
  entry point) using the SDK's `StreamableHTTPServerTransport`, alongside the
  existing `StdioServerTransport` — not replacing it.
- Decide `stateless_http` on vs. off once the Kubernetes replica count for the
  Gateway is known: stateless mode is what makes "any replica can answer any
  request" work behind a load balancer, at the cost of not being able to pin a
  session to one server process for connection-scoped state.
- Wire real per-caller authentication (`AuthSettings` / `token_verifier`) before this
  is reachable outside a trusted network — stdio's free process-boundary trust goes
  away the moment the Gateway is reachable over a network, per the security driver
  above. This is a **governance-boundary item** (compliance/security posture,
  production infrastructure) per this repo's `CLAUDE.md` — it needs sign-off as its
  own item before the StreamableHTTP endpoint is exposed anywhere but a local/dev
  network.
- Confirm the read-only vs. write-scoped service-account split (already required by
  `architecture.md`'s security notes) is enforced at the StreamableHTTP layer the
  same way it's enforced today — this ADR doesn't change that requirement, it just
  needs to survive the transport change.

**What this does not require:**
- No change to the actual tool/resource logic in `dmvReader.ts`, `dmvLiveSource.ts`,
  etc. — both transports sit in front of the same handlers, per the SDK's transport
  abstraction. This is additive at the transport layer only.
- No decision here about Kubernetes manifests, ingress, or TLS termination — those
  are downstream of this ADR, not part of it.

## What would change this decision

- If the Gateway's callers turn out to always run on the same host as the Gateway
  (i.e., the "central Kubernetes namespace, scaled independently" topology in
  `architecture.md` changes), stdio alone would become sufficient again and this ADR
  should be revisited.
- If a future requirement needs true server-to-client push independent of a request
  (not just responses to calls), that's a signal to re-examine SSE or a future
  transport, not StreamableHTTP.
