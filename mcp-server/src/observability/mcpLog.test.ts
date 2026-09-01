import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sendMcpLog } from "./mcpLog.js";

function makeFakeServer(sendLoggingMessage = vi.fn().mockResolvedValue(undefined)) {
  return { sendLoggingMessage } as unknown as McpServer;
}

describe("sendMcpLog", () => {
  it("happy path: sends a notifications/message-shaped payload with the event folded into data", () => {
    const server = makeFakeServer();
    sendMcpLog(server, "info", "mcp_tool_invocation_started", {
      tool: "read_sql_server_dmv",
      correlationId: "abc-123",
    });

    expect(server.sendLoggingMessage).toHaveBeenCalledWith({
      level: "info",
      logger: "coreops-mcp-server",
      data: { event: "mcp_tool_invocation_started", tool: "read_sql_server_dmv", correlationId: "abc-123" },
    });
  });

  it("defaults context to an empty object when omitted", () => {
    const server = makeFakeServer();
    sendMcpLog(server, "debug", "mcp_tool_invocation_started");

    expect(server.sendLoggingMessage).toHaveBeenCalledWith({
      level: "debug",
      logger: "coreops-mcp-server",
      data: { event: "mcp_tool_invocation_started" },
    });
  });

  it("failure path: a rejected sendLoggingMessage never throws or produces an unhandled rejection", async () => {
    const server = makeFakeServer(vi.fn().mockRejectedValue(new Error("no client connected")));

    expect(() => sendMcpLog(server, "error", "mcp_tool_error", {})).not.toThrow();
    // Let the fire-and-forget promise settle before the test ends, so a
    // regression that removes the .catch() shows up as an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
