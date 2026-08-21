import "./loadEnv.js";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readDmv } from "./dmvReader.js";
import { buildDashboardSummary, UnknownRoleError } from "./dashboardSummary.js";
import {
  generateRecommendation,
  SqlServerUnavailableError,
  InvalidDataFormatError,
} from "./recommendationService.js";
import {
  generateCloudRecommendation,
  CloudServiceUnavailableError,
  InvalidCloudDataFormatError,
} from "./cloudRecommendationService.js";
import { startMonitoring } from "./monitoringService.js";
import type { MonitoringHandle, MonitoringCycleResult } from "./monitoringService.js";
import { evaluateEscalation } from "./escalationService.js";
import {
  requestRollback,
  InsufficientPermissionsError,
  UnknownTaskTypeError,
  TaskNotReversibleError,
  RollbackDependencyError,
} from "./rollbackService.js";
import type { TaskRegistration } from "./rollbackService.js";
import { logEvent } from "./observability/logger.js";
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

// STORY-008 / REQ-016: single monitoring instance for the process, exposed via the
// routes below so a demo can toggle it live and see it running, rather than reading
// server logs. This module-level state is the process's only monitoring instance —
// monitoringService.ts itself stays instance-agnostic and stateless.
const RECENT_ALERTS_LIMIT = 10;
let monitoringHandle: MonitoringHandle | null = null;
let currentMonitoringTaskId: string | null = null;
let lastMonitoringCycle: MonitoringCycleResult | null = null;
let recentAlerts: MonitoringCycleResult[] = [];

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Request body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

// STORY-011 / REQ-015: the only two task types this process actually knows how to
// evaluate for rollback. start_monitoring is the one genuinely real, already-
// idempotent reversible action in this codebase (STORY-008's stop()); notify_operators
// is registered as honestly non-reversible — a delivered push notification really
// cannot be unsent — rather than left unregistered (which would deny it as "unknown"
// instead of "not reversible", the wrong reason for the wrong criterion).
function buildRollbackRegistry(): Record<string, TaskRegistration> {
  return {
    start_monitoring: {
      reversible: true,
      revert: async (taskId) => {
        if (!monitoringHandle || taskId !== currentMonitoringTaskId) {
          throw new Error(`No active monitoring session matches task "${taskId}".`);
        }
        monitoringHandle.stop();
        monitoringHandle = null;
        currentMonitoringTaskId = null;
        logEvent({ level: "info", event: "monitoring_control", context: { action: "stop", via: "rollback" } });
      },
    },
    notify_operators: {
      reversible: false,
      reason: "A delivered push notification cannot be unsent.",
    },
  };
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

  if (req.method === "GET" && url.pathname === "/api/dashboard/summary") {
    // STORY-005 / REQ-006 + REQ-009: role-based dashboard views. Same thin-wrapper
    // pattern as /dmv/exec-requests — buildDashboardSummary() holds the actual logic
    // and is unit-tested; this route is just plumbing plus the access-log call
    // ("Trust: Dashboard access is logged by user role") that a pure function can't
    // do for itself.
    const role = url.searchParams.get("role") ?? "";
    try {
      const dmvResult = await readDmv({ dmvName: "sys.dm_exec_requests" });
      const summary = buildDashboardSummary(role, dmvResult);
      logEvent({
        level: "info",
        event: "dashboard_access",
        context: { role, outcome: "success" },
      });
      sendJson(res, 200, summary);
    } catch (error) {
      if (error instanceof UnknownRoleError) {
        logEvent({
          level: "warn",
          event: "dashboard_access",
          context: { role, outcome: "failure", errorClass: "UnknownRoleError" },
        });
        sendJson(res, 400, { error: "UNKNOWN_ROLE", message: error.message });
        return;
      }
      logEvent({
        level: "error",
        event: "dashboard_access",
        context: {
          role,
          outcome: "failure",
          errorClass: error instanceof Error ? error.name : "Error",
        },
      });
      sendJson(res, 500, {
        error: "DASHBOARD_SUMMARY_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/recommendation") {
    // STORY-006 / REQ-007 + REQ-013: unlike /dmv/exec-requests, this route never
    // falls back to fixture data on a SQL Server failure — see
    // recommendationService.ts's header comment for why. Every attempt is logged
    // regardless of outcome ("Trust: all data access attempts are logged").
    const incidentId = url.searchParams.get("incidentId") ?? crypto.randomUUID();
    const description = url.searchParams.get("description") ?? "";
    try {
      const result = await generateRecommendation(incidentId, description);
      // STORY-009 / REQ-011: escalate to a human operator when the agent's own
      // confidence in this recommendation is below 60% — evaluateEscalation() logs
      // the escalation itself; this just surfaces it in the response for a demo.
      const escalation = evaluateEscalation(incidentId, result.confidence, result.rootCause);
      sendJson(res, 200, { incidentId, ...result, escalation });
    } catch (error) {
      if (error instanceof SqlServerUnavailableError) {
        sendJson(res, 503, {
          error: "SQL_SERVER_UNAVAILABLE",
          message: "Could not connect to SQL Server. No recommendation was generated.",
        });
        return;
      }
      if (error instanceof InvalidDataFormatError) {
        sendJson(res, 502, { error: "INVALID_DATA_FORMAT", message: error.message });
        return;
      }
      sendJson(res, 500, {
        error: "RECOMMENDATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cloud-recommendation") {
    // STORY-007 / REQ-008 + REQ-013: cloud-service counterpart to /api/recommendation
    // above — same rule, never falls back to fixture data on a cloud-service failure.
    // Every attempt is logged regardless of outcome by cloudRecommendationService.ts
    // itself ("Trust: all data access attempts are logged").
    const incidentId = url.searchParams.get("incidentId") ?? crypto.randomUUID();
    const description = url.searchParams.get("description") ?? "";
    try {
      const result = await generateCloudRecommendation(incidentId, description);
      // STORY-009 / REQ-011: same escalation check as /api/recommendation — REQ-011
      // is source-agnostic, so a low-confidence cloud-service recommendation escalates
      // exactly the same way a low-confidence SQL Server one does.
      const escalation = evaluateEscalation(incidentId, result.confidence, result.rootCause);
      sendJson(res, 200, { incidentId, ...result, escalation });
    } catch (error) {
      if (error instanceof CloudServiceUnavailableError) {
        sendJson(res, 503, {
          error: "CLOUD_SERVICE_UNAVAILABLE",
          message: "Could not connect to the cloud service. No recommendation was generated.",
        });
        return;
      }
      if (error instanceof InvalidCloudDataFormatError) {
        sendJson(res, 502, { error: "INVALID_DATA_FORMAT", message: error.message });
        return;
      }
      sendJson(res, 500, {
        error: "RECOMMENDATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/monitoring/start") {
    // STORY-008 / REQ-016: idempotent by construction — calling start while already
    // running does not spin up a second interval loop (that would double every
    // cycle's log lines and alerts), matching this repo's idempotency rule.
    if (monitoringHandle) {
      sendJson(res, 200, { running: true, message: "Monitoring is already running." });
      return;
    }
    currentMonitoringTaskId = crypto.randomUUID();
    monitoringHandle = startMonitoring({
      onCycle: (result) => {
        lastMonitoringCycle = result;
        if (result.alert) {
          recentAlerts = [result, ...recentAlerts].slice(0, RECENT_ALERTS_LIMIT);
        }
      },
    });
    logEvent({ level: "info", event: "monitoring_control", context: { action: "start", taskId: currentMonitoringTaskId } });
    // STORY-011: taskId is what a later POST /api/rollback call names to revert
    // this specific monitoring session.
    sendJson(res, 200, { running: true, taskId: currentMonitoringTaskId });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/monitoring/stop") {
    if (!monitoringHandle) {
      sendJson(res, 200, { running: false, message: "Monitoring is already stopped." });
      return;
    }
    monitoringHandle.stop();
    monitoringHandle = null;
    currentMonitoringTaskId = null;
    logEvent({ level: "info", event: "monitoring_control", context: { action: "stop" } });
    sendJson(res, 200, { running: false });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/monitoring/status") {
    sendJson(res, 200, {
      running: monitoringHandle !== null,
      taskId: currentMonitoringTaskId,
      lastCycle: lastMonitoringCycle,
      recentAlerts,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/rollback") {
    // STORY-011 / REQ-015: rollback for the two task types this process actually
    // knows about — see buildRollbackRegistry()'s header comment for why only these
    // two, and why notify_operators is registered rather than left unrecognized.
    let body: { taskId?: unknown; taskType?: unknown; actor?: unknown; role?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch (error) {
      sendJson(res, 400, {
        error: "INVALID_JSON_BODY",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const { taskId, taskType, actor, role } = body;
    if (
      typeof taskId !== "string" || !taskId ||
      typeof taskType !== "string" || !taskType ||
      typeof actor !== "string" || !actor ||
      typeof role !== "string" || !role
    ) {
      sendJson(res, 400, {
        error: "MISSING_FIELDS",
        message: "taskId, taskType, actor, and role are all required strings.",
      });
      return;
    }

    try {
      const result = await requestRollback(
        { taskId, taskType, requestedBy: { actor, role } },
        buildRollbackRegistry()
      );
      sendJson(res, 200, result);
    } catch (error) {
      if (error instanceof InsufficientPermissionsError) {
        sendJson(res, 403, { error: "INSUFFICIENT_PERMISSIONS", message: error.message });
        return;
      }
      if (error instanceof UnknownTaskTypeError) {
        sendJson(res, 404, { error: "UNKNOWN_TASK_TYPE", message: error.message });
        return;
      }
      if (error instanceof TaskNotReversibleError) {
        sendJson(res, 409, { error: "TASK_NOT_REVERSIBLE", message: error.message });
        return;
      }
      if (error instanceof RollbackDependencyError) {
        sendJson(res, 409, { error: "ROLLBACK_DEPENDENCY_BLOCKED", message: error.message });
        return;
      }
      sendJson(res, 500, {
        error: "ROLLBACK_FAILED",
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
