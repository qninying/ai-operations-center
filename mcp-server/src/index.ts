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

async function main() {
  const server = createCoreOpsMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("coreops-mcp-server: connected over stdio");
}

main().catch((error) => {
  console.error("coreops-mcp-server: fatal startup error", error);
  process.exit(1);
});
