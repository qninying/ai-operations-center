import "./loadEnv.js";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
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
import type { RemediationAction, ApprovalDecision } from "../../guardrails/remediationGuardrail.js";
import { AuditLog } from "../../guardrails/auditLog.js";
import { HitlQueue, HitlItemNotFoundError, UnauthorizedDeciderError, MfaRequiredError } from "../../guardrails/hitlQueue.js";
import { verifyPassword } from "./auth/credentials.js";
import { SessionStore } from "./auth/sessionStore.js";
import { serializeSessionCookie, clearSessionCookie, parseSessionCookie } from "./auth/cookies.js";
import { resolveStaticFilePath, mimeTypeFor } from "./staticFiles.js";
import { RateLimiter } from "./rateLimiter.js";

// Thin HTTP transport for R2's DMV read path, alongside the existing stdio MCP
// transport in index.ts. Both call the same readDmv() orchestrator — this file adds
// no new business logic, only a second way to reach it. GET / serves a small static
// dashboard (dashboard.html) that calls these same routes from the browser — the
// dashboard is presentation only, it has no logic of its own.

const PORT = Number(process.env.PORT ?? 8787);
const REQUEST_TIMEOUT_MS = 5000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardHtml = readFileSync(join(__dirname, "dashboard.html"), "utf-8");
const loginHtml = readFileSync(join(__dirname, "login.html"), "utf-8");

// Built React console (frontend/) — served from this same origin so its session
// cookie just works, no CORS. Unlike dashboardHtml/loginHtml, frontend/dist/ only
// exists if and after `npm run build-console` (or `npm run build` in frontend/) has
// run — it's build output, not committed source — so these paths are resolved here
// but deliberately NOT read at module load; see the GET /console and GET /assets/*
// route handlers below for why they're read per-request instead.
const frontendDistDir = join(__dirname, "..", "..", "frontend", "dist");
const frontendAssetsDir = join(frontendDistDir, "assets");

// Single-operator session auth. Fails fast at startup if either is unset — a
// deliberate exception to this file's usual "missing config -> fall back
// gracefully" convention (SQLSERVER_*, AZURE_* all degrade gracefully); falling
// back here would mean silently serving the dashboard with no real auth, which
// defeats the feature. See .env.example for how to generate AUTH_PASSWORD_HASH.
if (!process.env.AUTH_USERNAME || !process.env.AUTH_PASSWORD_HASH) {
  throw new Error(
    "AUTH_USERNAME and AUTH_PASSWORD_HASH must both be set in mcp-server/.env — see .env.example. " +
      "Generate a hash with: npm run hash-password -- '<your password>'"
  );
}
// Re-bound to plain `string` consts — TypeScript doesn't carry the guard's
// narrowing of process.env.X into route-handler closures defined later in this
// file, since it can't prove process.env wasn't mutated between the check and use.
const AUTH_USERNAME: string = process.env.AUTH_USERNAME;
const AUTH_PASSWORD_HASH: string = process.env.AUTH_PASSWORD_HASH;
const SESSION_COOKIE_SECURE = process.env.SESSION_COOKIE_SECURE === "true";
const sessionStore = new SessionStore();

interface Session {
  username: string;
}

// Returns the verified session, or null (and has already sent a 401) if none.
// Call at the top of every route that isn't GET /, GET /health, GET /login,
// POST /api/login, or POST /api/logout.
function requireSession(req: IncomingMessage, res: ServerResponse): Session | null {
  const sessionId = parseSessionCookie(req.headers.cookie);
  const session = sessionId ? sessionStore.verify(sessionId) : null;
  if (!session) {
    sendJson(res, 401, { error: "NOT_AUTHENTICATED", message: "Sign in required." });
    return null;
  }
  return { username: session.username };
}

// Confirmed absent by grep before this was added: no route in this file had any
// flood protection, and POST /api/login accepted unlimited password guesses. The
// login limiter is deliberately stricter than the general one, since it's the one
// route where a tight limit closes a real brute-force gap rather than just
// generic abuse protection. Keyed by socket address, not X-Forwarded-For — this
// server has no reverse proxy in front of it (per ADR-004), so the socket address
// is the real, unspoofable client address for the current deployment topology.
const generalRateLimiter = new RateLimiter({ windowMs: 60_000, maxRequests: 120 });
const loginRateLimiter = new RateLimiter({ windowMs: 60_000, maxRequests: 5 });

function clientKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

function sendRateLimited(res: ServerResponse, retryAfterMs: number, message: string) {
  res.setHeader("Retry-After", Math.ceil(retryAfterMs / 1000).toString());
  sendJson(res, 429, { error: "RATE_LIMITED", message });
}

// STORY-008 / REQ-016: single monitoring instance for the process, exposed via the
// routes below so a demo can toggle it live and see it running, rather than reading
// server logs. This module-level state is the process's only monitoring instance —
// monitoringService.ts itself stays instance-agnostic and stateless.
const RECENT_ALERTS_LIMIT = 10;
let monitoringHandle: MonitoringHandle | null = null;
let currentMonitoringTaskId: string | null = null;
let lastMonitoringCycle: MonitoringCycleResult | null = null;
let recentAlerts: MonitoringCycleResult[] = [];

function startMonitoringInternal(): string {
  currentMonitoringTaskId = crypto.randomUUID();
  monitoringHandle = startMonitoring({
    onCycle: (result) => {
      lastMonitoringCycle = result;
      if (result.alert) {
        recentAlerts = [result, ...recentAlerts].slice(0, RECENT_ALERTS_LIMIT);
      }
    },
    auditLog,
  });
  logEvent({ level: "info", event: "monitoring_control", context: { action: "start", taskId: currentMonitoringTaskId } });
  return currentMonitoringTaskId;
}

function stopMonitoringInternal(): void {
  if (!monitoringHandle) return;
  monitoringHandle.stop();
  monitoringHandle = null;
  currentMonitoringTaskId = null;
  logEvent({ level: "info", event: "monitoring_control", context: { action: "stop" } });
}

// Guardrail + HITL approval: this process's one real, safe, reversible action
// (the same monitoring service STORY-011's rollback already targets) is what a
// human-approved remediation actually executes. There is no real production-write
// execution path in this codebase — approving a fictional "restart prod-app-server-03"
// would have nothing real to do, so the proposed action is a genuinely restartable
// service instead. See PROGRESS.md for the decision and why.
// ADR-005: an append-only JSONL file so the governance record survives a restart —
// the in-memory-only version silently lost every approval decision on `npm restart`.
const auditLog = new AuditLog({ persistTo: join(__dirname, "..", "data", "audit-log.jsonl") });
const hitlQueue = new HitlQueue(auditLog);
// The real, password-verified login identity — not OPERATOR_CONTACTS, which stays a
// separate, notification-recipient display name for notifyOperators() (never
// verified against anything). Propose-time assignment (here) and decide-time
// identity (POST /api/guardrail/decide, below) both now trace back to the one real
// login, so HitlQueue's "only the assigned approver may decide" check is finally
// reachable instead of permanently dead code.
const GUARDRAIL_PRIMARY_APPROVER = AUTH_USERNAME;
const GUARDRAIL_BACKUP_APPROVER = "sre-oncall";

interface PendingRemediation {
  action: RemediationAction;
  executedAt: string | null;
}
const pendingRemediations = new Map<string, PendingRemediation>();

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
  const key = clientKey(req);

  const generalLimit = generalRateLimiter.check(key);
  if (!generalLimit.allowed) {
    sendRateLimited(res, generalLimit.retryAfterMs, "Too many requests. Please slow down.");
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(dashboardHtml);
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/login") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(loginHtml);
    return;
  }

  if (req.method === "GET" && url.pathname === "/console") {
    // Checked per request, not cached at module load — dist/ may not exist yet at
    // server startup (or may get built while the server is already running), and
    // neither case should crash this route or affect anything else this server
    // serves. 503, not 404: the route genuinely exists, it just isn't ready yet.
    const consoleIndexPath = join(frontendDistDir, "index.html");
    if (!existsSync(consoleIndexPath)) {
      sendJson(res, 503, {
        error: "CONSOLE_NOT_BUILT",
        message:
          "The Operations Console hasn't been built yet. Run `npm run build-console` " +
          "(or `npm run build` inside frontend/), then reload.",
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(readFileSync(consoleIndexPath, "utf-8"));
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
    const filePath = resolveStaticFilePath(frontendAssetsDir, url.pathname.slice("/assets".length));
    if (!filePath) {
      sendJson(res, 404, { error: "NOT_FOUND", path: url.pathname });
      return;
    }
    res.writeHead(200, { "Content-Type": mimeTypeFor(filePath) });
    res.end(readFileSync(filePath));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const loginLimit = loginRateLimiter.check(key);
    if (!loginLimit.allowed) {
      sendRateLimited(res, loginLimit.retryAfterMs, "Too many login attempts. Please wait before trying again.");
      return;
    }

    let body: { username?: unknown; password?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch (error) {
      sendJson(res, 400, {
        error: "INVALID_JSON_BODY",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const { username, password } = body;
    if (typeof username !== "string" || !username || typeof password !== "string" || !password) {
      sendJson(res, 400, { error: "MISSING_FIELDS", message: "username and password are both required." });
      return;
    }

    // One generic failure message for both a wrong username and a wrong password —
    // distinguishing them would let a caller enumerate valid usernames.
    if (username !== AUTH_USERNAME || !verifyPassword(password, AUTH_PASSWORD_HASH)) {
      sendJson(res, 401, { error: "INVALID_CREDENTIALS", message: "Incorrect username or password." });
      return;
    }

    const { sessionId, expiresAt } = sessionStore.create(username);
    res.setHeader(
      "Set-Cookie",
      serializeSessionCookie(sessionId, { secure: SESSION_COOKIE_SECURE, maxAgeMs: expiresAt - Date.now() })
    );
    logEvent({ level: "info", event: "login", context: { username, outcome: "success" } });
    sendJson(res, 200, { username });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    // Idempotent — clearing an absent/expired session is a safe no-op, matching this
    // repo's idempotency rule. No session required to call this.
    const sessionId = parseSessionCookie(req.headers.cookie);
    if (sessionId) {
      sessionStore.destroy(sessionId);
    }
    res.setHeader("Set-Cookie", clearSessionCookie(SESSION_COOKIE_SECURE));
    sendJson(res, 200, { loggedOut: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    const session = requireSession(req, res);
    if (!session) return;
    sendJson(res, 200, { username: session.username });
    return;
  }

  if (req.method === "GET" && url.pathname === "/dmv/exec-requests") {
    if (!requireSession(req, res)) return;
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
    // NOTE: the separate frontend/ React app also calls this route, unauthenticated,
    // via a same-origin Vite dev proxy — its own code already flags its deployment
    // topology as undecided. Gating this now means that call will 401 until the
    // frontend's cookie/CORS handling is addressed (flagged, not solved, per plan).
    if (!requireSession(req, res)) return;
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
    // ADR-002 step 2: incidentId is generated once, right here, at the true entry
    // point for this chain — and is the correlation ID every downstream write below
    // (generateRecommendation, evaluateEscalation, notifyOperators) shares.
    if (!requireSession(req, res)) return;
    const incidentId = url.searchParams.get("incidentId") ?? crypto.randomUUID();
    const description = url.searchParams.get("description") ?? "";
    try {
      const result = await generateRecommendation(incidentId, description, { auditLog });
      // STORY-009 / REQ-011: escalate to a human operator when the agent's own
      // confidence in this recommendation is below 60% — evaluateEscalation() logs
      // the escalation itself; this just surfaces it in the response for a demo.
      const escalation = evaluateEscalation(incidentId, result.confidence, result.rootCause, { auditLog });
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
    if (!requireSession(req, res)) return;
    const incidentId = url.searchParams.get("incidentId") ?? crypto.randomUUID();
    const description = url.searchParams.get("description") ?? "";
    try {
      const result = await generateCloudRecommendation(incidentId, description, { auditLog });
      // STORY-009 / REQ-011: same escalation check as /api/recommendation — REQ-011
      // is source-agnostic, so a low-confidence cloud-service recommendation escalates
      // exactly the same way a low-confidence SQL Server one does.
      const escalation = evaluateEscalation(incidentId, result.confidence, result.rootCause, { auditLog });
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
    if (!requireSession(req, res)) return;
    // STORY-008 / REQ-016: idempotent by construction — calling start while already
    // running does not spin up a second interval loop (that would double every
    // cycle's log lines and alerts), matching this repo's idempotency rule.
    if (monitoringHandle) {
      sendJson(res, 200, { running: true, message: "Monitoring is already running." });
      return;
    }
    const taskId = startMonitoringInternal();
    // STORY-011: taskId is what a later POST /api/rollback call names to revert
    // this specific monitoring session.
    sendJson(res, 200, { running: true, taskId });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/monitoring/stop") {
    if (!requireSession(req, res)) return;
    if (!monitoringHandle) {
      sendJson(res, 200, { running: false, message: "Monitoring is already stopped." });
      return;
    }
    stopMonitoringInternal();
    sendJson(res, 200, { running: false });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/monitoring/status") {
    if (!requireSession(req, res)) return;
    sendJson(res, 200, {
      running: monitoringHandle !== null,
      taskId: currentMonitoringTaskId,
      lastCycle: lastMonitoringCycle,
      recentAlerts,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/rollback") {
    if (!requireSession(req, res)) return;
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

  if (req.method === "POST" && url.pathname === "/api/guardrail/propose") {
    if (!requireSession(req, res)) return;
    // Same real scenario as guardrails/demoUnsafeAction.ts: a recommendation that's
    // evidence-linked and of a valid, reversible type, missing only human approval.
    // Enqueues into the real HITL queue (guardrails/hitlQueue.ts) rather than doing a
    // single stateless check — a human can now actually act on this specific item.
    const action: RemediationAction = {
      actionType: "restart_service",
      evidenceIds: ["evt-4471"],
      approval: null,
      targetSystem: { name: "monitoring-collector", productionWriteProtected: true },
    };
    const correlationId = crypto.randomUUID();
    const item = hitlQueue.enqueue({
      request: { ...action },
      correlationId,
      contextPackage: "Monitoring collector restart, evidence-linked, awaiting approval.",
      primaryApprover: GUARDRAIL_PRIMARY_APPROVER,
      backupApprover: GUARDRAIL_BACKUP_APPROVER,
    });
    pendingRemediations.set(item.itemId, { action, executedAt: null });
    const result = checkRemediationGuardrail(action);
    logEvent({ level: "info", event: "guardrail_proposed", context: { itemId: item.itemId, correlationId } });
    sendJson(res, 200, { itemId: item.itemId, correlationId, proposedAction: action, result, approver: GUARDRAIL_PRIMARY_APPROVER });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/guardrail/decide") {
    const session = requireSession(req, res);
    if (!session) return;

    let body: { itemId?: unknown; decision?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch (error) {
      sendJson(res, 400, {
        error: "INVALID_JSON_BODY",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const { itemId, decision } = body;
    if (typeof itemId !== "string" || !itemId || (decision !== "approve" && decision !== "reject")) {
      sendJson(res, 400, {
        error: "MISSING_FIELDS",
        message: "itemId (string) and decision ('approve' | 'reject') are required.",
      });
      return;
    }

    const pending = pendingRemediations.get(itemId);
    if (!pending) {
      sendJson(res, 404, { error: "UNKNOWN_ITEM", message: `No pending remediation with id "${itemId}".` });
      return;
    }

    try {
      // decidedBy is now the real, password-verified session identity (session.username),
      // not a hardcoded constant — this is what makes HitlQueue's "only the assigned
      // approver may decide" check meaningful. MFA itself is still not implemented
      // anywhere in this system, so `true` remains an honest stand-in for that one
      // factor only, not a claim that a real MFA challenge happened.
      const item = hitlQueue.decide(itemId, decision, session.username, true);

      if (decision === "reject") {
        sendJson(res, 200, { itemId, status: item.status, executed: false });
        return;
      }

      const approval: ApprovalDecision = {
        status: "approved",
        decidedBy: item.decidedBy!,
        decidedAt: new Date().toISOString(),
      };
      const approvedAction: RemediationAction = { ...pending.action, approval };
      const result = checkRemediationGuardrail(approvedAction);

      if (!result.allowed) {
        sendJson(res, 200, { itemId, status: item.status, result, executed: false });
        return;
      }

      // Real execution: restart the one real, reversible service this process has.
      stopMonitoringInternal();
      const taskId = startMonitoringInternal();
      pending.executedAt = new Date().toISOString();
      logEvent({
        level: "info",
        event: "guardrail_executed",
        context: { itemId, actionType: approvedAction.actionType, taskId },
      });

      sendJson(res, 200, {
        itemId,
        status: item.status,
        result,
        executed: true,
        executedAt: pending.executedAt,
        taskId,
      });
      return;
    } catch (error) {
      if (error instanceof HitlItemNotFoundError) {
        sendJson(res, 404, { error: "UNKNOWN_ITEM", message: error.message });
        return;
      }
      if (error instanceof UnauthorizedDeciderError) {
        sendJson(res, 403, { error: "UNAUTHORIZED_DECIDER", message: error.message });
        return;
      }
      if (error instanceof MfaRequiredError) {
        sendJson(res, 403, { error: "MFA_REQUIRED", message: error.message });
        return;
      }
      throw error;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/audit") {
    if (!requireSession(req, res)) return;
    // ADR-002 "Consequences": the audit log's actual value is forCorrelationId()
    // reconstruction — this route is what makes that demoable live, not just
    // asserted in a test. Real data only: whatever correlationId a real
    // /api/recommendation, /api/cloud-recommendation, monitoring cycle, or guardrail
    // decision actually used.
    const correlationId = url.searchParams.get("correlationId");
    if (!correlationId) {
      sendJson(res, 400, {
        error: "MISSING_CORRELATION_ID",
        message: "Query param 'correlationId' is required.",
      });
      return;
    }
    const entries = auditLog.forCorrelationId(correlationId);
    sendJson(res, 200, { correlationId, count: entries.length, entries });
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
