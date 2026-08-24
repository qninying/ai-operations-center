import "./loadEnv.js";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createCoreOpsMcpServer } from "./mcpServerFactory.js";
import { verifyBearerToken } from "./auth/apiToken.js";
import { logEvent } from "./observability/logger.js";

// ADR-001's network-reachable transport for the deployed Tool Gateway — AI agents,
// the Execution Service, or anything else running centrally connect here, not to
// index.ts's stdio entry point (which stays local/dev-only, unchanged).
//
// Fail fast on missing config, same deliberate exception to "degrade gracefully"
// already established for AUTH_USERNAME/AUTH_PASSWORD_HASH in httpServer.ts:
// starting with no real token would mean silently exposing every DMV read tool to
// anyone who can reach the port.
if (!process.env.MCP_API_TOKEN) {
  throw new Error(
    "MCP_API_TOKEN must be set in mcp-server/.env — see .env.example. " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  );
}
const MCP_API_TOKEN: string = process.env.MCP_API_TOKEN;
const PORT = Number(process.env.MCP_HTTP_PORT ?? 8788);

function sendJsonRpcError(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

// Stateless mode (sessionIdGenerator: undefined), per ADR-001's own decision driver:
// "if the RCA Agent or Execution Service scale to multiple replicas, each replica
// needs to reach the *same* running Gateway concurrently" — a fresh server+transport
// pair per request means any replica can answer any request, with no session
// pinned to one process. Mirrors the MCP SDK's own stateless StreamableHTTP example.
async function handleMcpRequest(req: IncomingMessage, res: ServerResponse) {
  if (!verifyBearerToken(req.headers.authorization, MCP_API_TOKEN)) {
    logEvent({ level: "warn", event: "mcp_http_unauthorized", service: "mcp-http-server" });
    sendJsonRpcError(res, 401, "A valid Bearer token is required.");
    return;
  }

  const server = createCoreOpsMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (error) {
    logEvent({
      level: "error",
      event: "mcp_http_request_failed",
      service: "mcp-http-server",
      context: { message: error instanceof Error ? error.message : String(error) },
    });
    if (!res.headersSent) {
      sendJsonRpcError(res, 500, "Internal server error.");
    }
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (url.pathname === "/mcp") {
    if (req.method === "POST") {
      handleMcpRequest(req, res).catch((error) => {
        logEvent({
          level: "error",
          event: "mcp_http_unhandled_error",
          service: "mcp-http-server",
          context: { message: error instanceof Error ? error.message : String(error) },
        });
        if (!res.headersSent) {
          sendJsonRpcError(res, 500, "Internal server error.");
        }
      });
      return;
    }
    // GET/DELETE /mcp: no server-initiated notification stream or session
    // deletion is implemented (stateless mode has no session to delete) — matches
    // the SDK's own stateless example, which returns 405 for both.
    sendJsonRpcError(res, 405, "Method not allowed.");
    return;
  }

  sendJsonRpcError(res, 404, "Not found.");
});

server.listen(PORT, () => {
  logEvent({ level: "info", event: "mcp_http_server_started", service: "mcp-http-server", context: { port: PORT } });
});
