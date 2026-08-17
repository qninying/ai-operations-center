import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readDmv } from "./dmvReader.js";
import { checkRemediationGuardrail } from "../../guardrails/remediationGuardrail.js";

// Thin HTTP transport for R2's DMV read path, alongside the existing stdio MCP
// transport in index.ts. Both call the same readDmv() orchestrator — this file adds
// no new business logic, only a second way to reach it. GET / serves a small static
// dashboard (dashboard.html) that calls these same routes from the browser — the
// dashboard is presentation only, it has no logic of its own.

const PORT = Number(process.env.PORT ?? 8787);
const REQUEST_TIMEOUT_MS = 5000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardHtml = readFileSync(join(__dirname, "dashboard.html"), "utf-8");

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(dashboardHtml);
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/dmv/exec-requests") {
    const databaseName = url.searchParams.get("databaseName") ?? undefined;
    try {
      const result = await readDmv({ dmvName: "sys.dm_exec_requests", databaseName });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, {
        error: "DMV_READ_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/guardrail/check-demo") {
    // Same real scenario as guardrails/demoUnsafeAction.ts: a recommendation that's
    // evidence-linked and of a valid, reversible type, missing only human approval.
    const proposedAction = {
      actionType: "restart_service",
      evidenceIds: ["evt-4471"],
      approval: null,
      targetSystem: { name: "prod-app-server-03", productionWriteProtected: true },
    };
    const result = checkRemediationGuardrail(proposedAction);
    sendJson(res, 200, { proposedAction, result });
    return;
  }

  sendJson(res, 404, { error: "NOT_FOUND", path: url.pathname });
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error("coreops-http: unhandled request error", error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "INTERNAL_ERROR" });
    }
  });
});

server.requestTimeout = REQUEST_TIMEOUT_MS;

server.listen(PORT, () => {
  console.error(`coreops-http: listening on http://localhost:${PORT}`);
});
