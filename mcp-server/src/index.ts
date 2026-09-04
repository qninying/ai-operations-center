import "./loadEnv.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCoreOpsMcpServer } from "./mcpServerFactory.js";

// CoreOps MCP Tool Gateway (R2): a read-only stdio MCP server. Per the R4 guardrail
// already locked in project-blueprint/requirements.md, this surface never writes to
// a monitored system — every resource and tool here is read-only or a stub.
//
// Per ADR-001, this stays the local, dev-only entry point — zero-config, trusted by
// process ancestry, unchanged in behavior. The network-reachable, per-caller-
// authenticated transport ADR-001 also decided on lives in httpMcpServer.ts, sharing
// the same tool/resource logic via mcpServerFactory.ts rather than forking it.
//
// Explicit single-user assumption, per docs/TRANSPORT_DECISION.md: stdio is a
// same-machine parent-child pipe — one client process, one server process, tied
// to that specific OS-level parent/child relationship. There is no notion of
// "which caller" here to keep separate the way a network transport would need
// to; the process itself IS the session, for exactly one user. Nobody should
// scale this by, say, spawning it behind a shared queue or reusing one instance
// across multiple unrelated callers — that would silently break the one
// assumption this transport is built on. The stateless, many-concurrent-caller
// design belongs to httpMcpServer.ts, not here.

async function main() {
  const server = createCoreOpsMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Explicit so an operator can tell the transport and state model from the
  // logs alone, without reading source — per docs/TRANSPORT_DECISION.md. Written
  // to stderr, not stdout, since stdout is the JSON-RPC protocol channel itself
  // on this transport — anything else on it would corrupt the stream.
  console.error("coreops-mcp-server: connected over stdio (transport=stdio, stateModel=single-process-single-user, not stateless)");
}

main().catch((error) => {
  console.error("coreops-mcp-server: fatal startup error", error);
  process.exit(1);
});
