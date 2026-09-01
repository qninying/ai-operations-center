import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Sends a structured MCP `notifications/message` — the client-visible logging
// channel, declared via the `logging: {}` capability at server construction in
// mcpServerFactory.ts. Without that declaration, an MCP client silently drops
// every one of these — no error on either side. Distinct from
// observability/logger.ts, which writes to this process's own stderr for infra
// log aggregation: this reaches the connected MCP client itself (visible in the
// Inspector's Console tab).
//
// Fire-and-forget by design: a logging channel must never be able to break the
// tool's actual work, whether because no client is connected, the client never
// declared interest, or the transport hiccups.
export type McpLogLevel = "debug" | "info" | "notice" | "warning" | "error";

export function sendMcpLog(
  server: McpServer,
  level: McpLogLevel,
  event: string,
  context: Record<string, unknown> = {}
): void {
  server
    .sendLoggingMessage({
      level,
      logger: "coreops-mcp-server",
      data: { event, ...context },
    })
    .catch(() => {
      // Best-effort — see module comment above.
    });
}
