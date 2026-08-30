import "./loadEnv.js";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readDmv } from "./dmvReader.js";
import { assessBlockingSessionRemediation } from "./sqlRemediationSafety.js";
import { restartSupersetContainer, restartPostgresContainer } from "./dockerExecutor.js";
import { queryPgActivity } from "./pgActivitySource.js";
import { assessPostgresRemediation } from "./pgRemediationSafety.js";
import { terminatePostgresBackend } from "./pgRemediationExecutor.js";
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
import {
  generateCorrelatedRecommendation,
  AllEvidenceSourcesUnavailableError,
  InvalidSsrsDataFormatError,
} from "./correlatedRecommendationService.js";
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
import { recordSystemEvent } from "./observability/auditWrite.js";
import { checkRemediationGuardrail } from "../../guardrails/remediationGuardrail.js";
import type { RemediationAction, ApprovalDecision } from "../../guardrails/remediationGuardrail.js";
import { AuditLog } from "../../guardrails/auditLog.js";
import { HitlQueue, HitlItemNotFoundError, UnauthorizedDeciderError, MfaRequiredError, AlreadyDecidedError } from "../../guardrails/hitlQueue.js";
import { TotpVerifier } from "./auth/totp.js";
import { findAuthenticatedUser, DirectoryUser } from "./auth/userDirectory.js";
import { SessionStore } from "./auth/sessionStore.js";
import { serializeSessionCookie, clearSessionCookie, parseSessionCookie } from "./auth/cookies.js";
import { resolveStaticFilePath, mimeTypeFor } from "./staticFiles.js";
import { RateLimiter } from "./rateLimiter.js";
import { isDemoModeEnabled } from "./demoModeGate.js";
import { notifyOperators } from "./notificationService.js";
import { generateTotpCode } from "./auth/totp.js";
import { startIncidentFeed, getRevealedIncidents, markResolved } from "./incidentFeedService.js";

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

// Single-operator session auth, now including a real second factor. Fails fast at
// startup if any is unset — a deliberate exception to this file's usual "missing
// config -> fall back gracefully" convention (SQLSERVER_*, AZURE_* all degrade
// gracefully); falling back here would mean silently serving the dashboard with no
// real auth (or an MFA check permanently satisfied by nothing), which defeats the
// feature. See .env.example for how to generate AUTH_PASSWORD_HASH/MFA_TOTP_SECRET.
if (!process.env.AUTH_USERNAME || !process.env.AUTH_PASSWORD_HASH || !process.env.MFA_TOTP_SECRET) {
  throw new Error(
    "AUTH_USERNAME, AUTH_PASSWORD_HASH, and MFA_TOTP_SECRET must all be set in mcp-server/.env — see .env.example. " +
      "Generate a password hash with: npm run hash-password -- '<your password>' " +
      "and a TOTP secret with: npm run generate-totp-secret"
  );
}
// Re-bound to plain `string` consts — TypeScript doesn't carry the guard's
// narrowing of process.env.X into route-handler closures defined later in this
// file, since it can't prove process.env wasn't mutated between the check and use.
const AUTH_USERNAME: string = process.env.AUTH_USERNAME;
const AUTH_PASSWORD_HASH: string = process.env.AUTH_PASSWORD_HASH;
const MFA_TOTP_SECRET: string = process.env.MFA_TOTP_SECRET;
const SESSION_COOKIE_SECURE = process.env.SESSION_COOKIE_SECURE === "true";
const sessionStore = new SessionStore();
const totpVerifier = new TotpVerifier(MFA_TOTP_SECRET);

// Optional second identity for guardrails/hitlQueue.ts's escalation path — see
// .env.example. Deliberately NOT fail-fast: unset keeps this a single-operator
// deployment exactly as it works today. Each configured user gets its own
// TotpVerifier instance — replay-protection state (lastAcceptedTimestep) is
// private per-instance, so sharing one across two secrets would corrupt it for
// both users.
const BACKUP_APPROVER_USERNAME = process.env.BACKUP_APPROVER_USERNAME;
const BACKUP_APPROVER_PASSWORD_HASH = process.env.BACKUP_APPROVER_PASSWORD_HASH;
const BACKUP_APPROVER_TOTP_SECRET = process.env.BACKUP_APPROVER_TOTP_SECRET;
const backupApproverConfigured = Boolean(
  BACKUP_APPROVER_USERNAME && BACKUP_APPROVER_PASSWORD_HASH && BACKUP_APPROVER_TOTP_SECRET
);

const directoryUsers: DirectoryUser[] = [
  { username: AUTH_USERNAME, passwordHash: AUTH_PASSWORD_HASH, totpVerifier, kind: "primary" },
];
if (backupApproverConfigured) {
  directoryUsers.push({
    username: BACKUP_APPROVER_USERNAME!,
    passwordHash: BACKUP_APPROVER_PASSWORD_HASH!,
    totpVerifier: new TotpVerifier(BACKUP_APPROVER_TOTP_SECRET!),
    kind: "backup",
  });
}

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
// Always on, independent of the "Continuous monitoring" Start/Stop feature above
// (that one is a narrower, manually-toggled SQL-blocking-chain-only detector) —
// the unified incident feed across SQL/Cloud/SSRS/Docker runs from boot.
startIncidentFeed();
// The real, password-verified login identity — not OPERATOR_CONTACTS, which stays a
// separate, notification-recipient display name for notifyOperators() (never
// verified against anything). Propose-time assignment (here) and decide-time
// identity (POST /api/guardrail/decide, below) both now trace back to the one real
// login, so HitlQueue's "only the assigned approver may decide" check is finally
// reachable instead of permanently dead code.
const GUARDRAIL_PRIMARY_APPROVER = AUTH_USERNAME;
// Was always the literal string "sre-oncall" — a hardcoded placeholder no one
// could ever actually log in as, so HitlQueue's escalation-to-backup-approver
// path (see checkForTimeout()) was unit-tested with a mocked decidedBy string but
// never reachable by a real second authenticated human. Now names a real,
// loggable-in identity whenever BACKUP_APPROVER_* is configured (see ADR-007);
// falls back to the same honest placeholder, unchanged, when it isn't.
const GUARDRAIL_BACKUP_APPROVER = backupApproverConfigured ? BACKUP_APPROVER_USERNAME! : "sre-oncall";

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

    let body: { username?: unknown; password?: unknown; totpCode?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch (error) {
      sendJson(res, 400, {
        error: "INVALID_JSON_BODY",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const { username, password, totpCode } = body;
    if (
      typeof username !== "string" || !username ||
      typeof password !== "string" || !password ||
      typeof totpCode !== "string" || !totpCode
    ) {
      sendJson(res, 400, {
        error: "MISSING_FIELDS",
        message: "username, password, and totpCode are all required.",
      });
      return;
    }

    // One generic failure message regardless of a wrong username, wrong password,
    // wrong TOTP code, or which of 1-2 configured users (if any) partially matched
    // — distinguishing any of these would let a caller enumerate valid usernames
    // or probe which factor was wrong. findAuthenticatedUser()'s own short-circuit
    // per user means a wrong password never reaches that user's totpVerifier.verify(),
    // so a mistyped password can't burn/replay-block that user's currently-valid code.
    const matchedUser = findAuthenticatedUser(directoryUsers, username, password, totpCode);
    if (!matchedUser) {
      sendJson(res, 401, { error: "INVALID_CREDENTIALS", message: "Incorrect username, password, or code." });
      return;
    }

    const { sessionId, expiresAt } = sessionStore.create(matchedUser.username);
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
      // Unlike /api/dashboard/summary's equivalent catch, this route had no
      // logEvent here — the client got the real message, but an unexpected DMV
      // failure left zero server-side observable record. Found during an audit
      // of this file's own "never swallow" convention; matches the pattern
      // already established at /api/dashboard/summary.
      logEvent({
        level: "error",
        event: "dmv_read_failed",
        context: {
          databaseName: databaseName ?? null,
          errorClass: error instanceof Error ? error.name : "Error",
        },
      });
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
      // Reachable via real, currently-unlogged-upstream error types
      // (MalformedResponseError from rootCauseAgent.ts, InvalidConfidenceScoreError
      // from escalationService.ts) — found during an audit of this file's own
      // "never swallow" convention. The two branches above are covered by logging
      // already done in recommendationService.ts before those errors are thrown;
      // this is the one path that wasn't.
      logEvent({
        level: "error",
        event: "recommendation_failed",
        context: { incidentId, errorClass: error instanceof Error ? error.name : "Error" },
      });
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
      // Same gap and same fix as /api/recommendation's equivalent catch-all —
      // reachable via unlogged-upstream MalformedResponseError/InvalidConfidenceScoreError.
      logEvent({
        level: "error",
        event: "recommendation_failed",
        context: { incidentId, errorClass: error instanceof Error ? error.name : "Error" },
      });
      sendJson(res, 500, {
        error: "RECOMMENDATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/correlated-recommendation") {
    // REQ-017: gathers evidence from BOTH SQL Server DMVs and SSRS ExecutionLog3
    // for one incident and hands it ALL to analyzeIncidentRootCause() in a single
    // call — see correlatedRecommendationService.ts for why there's no fabricated
    // join key between the two systems' row shapes.
    if (!requireSession(req, res)) return;
    const incidentId = url.searchParams.get("incidentId") ?? crypto.randomUUID();
    const description = url.searchParams.get("description") ?? "";
    const reportPath = url.searchParams.get("reportPath") ?? undefined;
    try {
      const result = await generateCorrelatedRecommendation(incidentId, description, { reportPath, auditLog });
      const escalation = evaluateEscalation(incidentId, result.confidence, result.rootCause, { auditLog });
      sendJson(res, 200, { incidentId, ...result, escalation });
    } catch (error) {
      if (error instanceof AllEvidenceSourcesUnavailableError) {
        sendJson(res, 503, {
          error: "ALL_EVIDENCE_SOURCES_UNAVAILABLE",
          message: "Could not connect to SQL Server or SSRS. No recommendation was generated.",
        });
        return;
      }
      if (error instanceof InvalidDataFormatError) {
        sendJson(res, 502, { error: "INVALID_DATA_FORMAT", message: error.message });
        return;
      }
      if (error instanceof InvalidSsrsDataFormatError) {
        sendJson(res, 502, { error: "INVALID_SSRS_DATA_FORMAT", message: error.message });
        return;
      }
      logEvent({
        level: "error",
        event: "recommendation_failed",
        context: { incidentId, errorClass: error instanceof Error ? error.name : "Error" },
      });
      sendJson(res, 500, {
        error: "RECOMMENDATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/incidents") {
    // Unified feed across SQL/Cloud/SSRS/Docker — see incidentFeedService.ts.
    // Only already-revealed incidents are returned; the background poller (not
    // this request handler) owns reveal timing, so every client polling this
    // route at any time sees the exact same state.
    if (!requireSession(req, res)) return;
    sendJson(res, 200, { incidents: getRevealedIncidents() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/incidents/resolve") {
    // Dashboard bookkeeping, deliberately separate from /api/guardrail/decide —
    // that route is about the approval workflow itself; this just tells the
    // feed "stop showing this one," called by the client right after a real
    // Approve succeeds.
    if (!requireSession(req, res)) return;
    let body: { incidentId?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch (error) {
      sendJson(res, 400, { error: "INVALID_JSON_BODY", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (typeof body.incidentId !== "string" || !body.incidentId) {
      sendJson(res, 400, { error: "MISSING_FIELDS", message: "incidentId is required." });
      return;
    }
    markResolved(body.incidentId);
    sendJson(res, 200, { resolved: true });
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
      // Reachable via a plain Error thrown inside buildRollbackRegistry()'s own
      // revert() implementations (e.g. "no active monitoring session matches
      // task"), which had no logging of its own — found during an audit of this
      // file's own "never swallow" convention.
      logEvent({
        level: "error",
        event: "rollback_failed",
        context: { taskId, taskType, errorClass: error instanceof Error ? error.name : "Error" },
      });
      sendJson(res, 500, {
        error: "ROLLBACK_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/guardrail/propose") {
    if (!requireSession(req, res)) return;

    // Optional and best-effort: an absent or malformed body, or an
    // unrecognized source, falls back to the original generic action below
    // rather than erroring — this route predates incident context and
    // stays backward compatible for any caller that doesn't send it.
    let body: { incidentId?: unknown; source?: unknown } = {};
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch {
      // no body sent — fine, falls through to the generic default
    }
    const incidentId = typeof body.incidentId === "string" ? body.incidentId : undefined;
    const source = typeof body.source === "string" ? body.source : undefined;
    const evidenceIds = incidentId ? [incidentId] : ["evt-4471"];

    // ADR-010: SQL blocking-chain incidents get real DBA judgment, not a
    // static mapping — assessBlockingSessionRemediation() is the actual
    // gate on whether kill_blocking_session is even offered.
    if (source === "sql" && incidentId) {
      // incidentId's session id is the BLOCKED session (what the incident is
      // named for) — the actual remediation target is whichever session is
      // blocking it, found by looking that row up first.
      const blockedSessionId = Number(incidentId.split(":")[2]);
      const dmvResult = await readDmv({ dmvName: "sys.dm_exec_requests" });
      const blockedRow = dmvResult.rows.find((row) => row.session_id === blockedSessionId);
      const blockerSessionId = blockedRow?.blocking_session_id;

      if (blockerSessionId === undefined) {
        sendJson(res, 200, { noSafeAction: true, reason: `No evidence found for session ${blockedSessionId} — cannot assess a remediation.` });
        return;
      }

      const assessment = assessBlockingSessionRemediation(blockerSessionId, dmvResult.rows);

      if (!assessment.safe) {
        logEvent({ level: "info", event: "guardrail_no_safe_action", context: { incidentId, blockerSessionId, reason: assessment.reason } });
        sendJson(res, 200, { noSafeAction: true, reason: assessment.reason });
        return;
      }

      const blocker = dmvResult.rows.find((row) => row.session_id === blockerSessionId);
      const action: RemediationAction = {
        actionType: "kill_blocking_session",
        evidenceIds,
        approval: null,
        targetSystem: { name: `session ${blockerSessionId} on ${blocker?.database_name ?? "unknown"}`, productionWriteProtected: true },
      };
      return proposeAction(res, action, `Kill blocking session ${blockerSessionId}, evidence-linked, awaiting approval.`);
    }

    // Postgres unreachable (the dev-postgres container itself is down) is a
    // distinct incident shape from a blocking-query chain — its id carries no
    // pid to parse, so this must be checked before the pid-based branch
    // below. Mirrors the `docker` entry in SOURCE_ACTIONS exactly: same
    // action type, same real-restart mechanism (dockerExecutor.ts), just a
    // different target container.
    if (source === "postgres" && incidentId === "postgres:unreachable") {
      const action: RemediationAction = {
        actionType: "restart_service",
        evidenceIds,
        approval: null,
        targetSystem: { name: "dev-postgres", productionWriteProtected: true },
      };
      return proposeAction(res, action, `restart_service on dev-postgres, evidence-linked, awaiting approval.`);
    }

    // ADR-013: same real-DBA-judgment shape as SQL above, translated to
    // Postgres — assessPostgresRemediation() is the actual gate on whether
    // kill_postgres_backend is even offered.
    if (source === "postgres" && incidentId) {
      // incidentId's pid is the BLOCKED backend — the actual remediation
      // target is whichever backend is blocking it, found by looking that
      // row up first, same split as the SQL branch above.
      const blockedPid = Number(incidentId.split(":")[2]);
      const pgRows = await queryPgActivity();
      const blockedRow = pgRows.find((row) => row.pid === blockedPid);
      const blockerPid = blockedRow?.blocked_by[0];

      if (blockerPid === undefined) {
        sendJson(res, 200, { noSafeAction: true, reason: `No evidence found for backend ${blockedPid} — cannot assess a remediation.` });
        return;
      }

      const assessment = assessPostgresRemediation(blockerPid, pgRows);

      if (!assessment.safe) {
        logEvent({ level: "info", event: "guardrail_no_safe_action", context: { incidentId, blockerPid, reason: assessment.reason } });
        sendJson(res, 200, { noSafeAction: true, reason: assessment.reason });
        return;
      }

      const blocker = pgRows.find((row) => row.pid === blockerPid);
      const action: RemediationAction = {
        actionType: "kill_postgres_backend",
        evidenceIds,
        approval: null,
        targetSystem: { name: `backend ${blockerPid} on ${blocker?.datname ?? "unknown"}`, productionWriteProtected: true },
      };
      return proposeAction(res, action, `Terminate backend ${blockerPid}, evidence-linked, awaiting approval.`);
    }

    // SSRS/Cloud/Docker: a real, source-correct action type and target —
    // textbook-correct for SSRS specifically, since Report Server genuinely
    // runs under IIS in a real deployment.
    const SOURCE_ACTIONS: Record<string, { actionType: string; targetSystem: { name: string; productionWriteProtected: boolean } }> = {
      ssrs: { actionType: "recycle_app_pool", targetSystem: { name: "ssrs-report-server", productionWriteProtected: true } },
      cloud: { actionType: "restart_service", targetSystem: { name: "ssis-agent", productionWriteProtected: true } },
      docker: { actionType: "restart_service", targetSystem: { name: "dev-superset", productionWriteProtected: true } },
    };
    const mapped = source ? SOURCE_ACTIONS[source] : undefined;

    const action: RemediationAction = mapped
      ? { actionType: mapped.actionType, evidenceIds, approval: null, targetSystem: mapped.targetSystem }
      : {
          // No source provided or unrecognized — the original generic
          // action, unchanged, for backward compatibility.
          actionType: "restart_service",
          evidenceIds,
          approval: null,
          targetSystem: { name: "monitoring-collector", productionWriteProtected: true },
        };
    return proposeAction(res, action, `${action.actionType} on ${action.targetSystem.name}, evidence-linked, awaiting approval.`);

    function proposeAction(res: ServerResponse, action: RemediationAction, contextPackage: string) {
      const correlationId = crypto.randomUUID();
      const item = hitlQueue.enqueue({
        request: { ...action },
        correlationId,
        contextPackage,
        primaryApprover: GUARDRAIL_PRIMARY_APPROVER,
        backupApprover: GUARDRAIL_BACKUP_APPROVER,
      });
      pendingRemediations.set(item.itemId, { action, executedAt: null });
      const result = checkRemediationGuardrail(action);
      logEvent({ level: "info", event: "guardrail_proposed", context: { itemId: item.itemId, correlationId, actionType: action.actionType } });
      sendJson(res, 200, { itemId: item.itemId, correlationId, proposedAction: action, result, approver: GUARDRAIL_PRIMARY_APPROVER });
    }
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

    // Without this, escalation to the backup approver (guardrails/hitlQueue.ts's
    // checkForTimeout()) was fully unit-tested but never actually reachable from a
    // live request — nothing in this file ever called it, so activeApprover could
    // never genuinely switch from the primary to the backup approver in
    // production, no matter how long a real deployment waited.
    hitlQueue.checkForTimeout(itemId);

    try {
      // decidedBy is now the real, password-verified session identity (session.username)
      // of whichever real user is currently logged in — primary or backup approver —
      // not a hardcoded constant, which is what makes HitlQueue's "only the assigned
      // approver may decide" check meaningful across both identities. `true` is no
      // longer a placeholder: since POST /api/login now requires a valid TOTP code
      // from findAuthenticatedUser() to issue a session at all, every session past
      // requireSession() was already MFA-verified at login for whichever user it
      // belongs to — this reads that fact, not a hardcoded stand-in for it.
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

      // Shared by every real-execution branch below (ADR-012 Docker, ADR-013
      // Postgres) — one code path for the "run it, then honestly report
      // confirmed-vs-unconfirmed-vs-failed" shape, so the two real actions
      // can't quietly drift into different response shapes over time.
      // pending/decidedBy captured as const aliases — TS's narrowing of the
      // outer `pending`/`session` doesn't carry into a nested function
      // declaration, since it can't prove they're unchanged by call time.
      const pendingItem = pending;
      const decidedBy = session.username;
      async function executeReal(
        run: () => Promise<{ confirmed: boolean; detail: string }>,
        errorCode: string
      ): Promise<void> {
        try {
          const outcome = await run();
          pendingItem.executedAt = new Date().toISOString();
          logEvent({
            level: "info",
            event: "guardrail_executed",
            context: { itemId, actionType: approvedAction.actionType, realExecution: true, ...outcome },
          });
          recordSystemEvent(
            auditLog,
            decidedBy,
            "guardrail_executed",
            "success",
            {
              actionType: approvedAction.actionType,
              targetSystem: approvedAction.targetSystem.name,
              realExecution: true,
              ...outcome,
            },
            item.correlationId
          );
          sendJson(res, 200, {
            itemId,
            status: item.status,
            result,
            executed: true,
            executedAt: pendingItem.executedAt,
            realExecution: true,
            realOutcome: outcome,
          });
        } catch (error) {
          const errorClass = error instanceof Error ? error.name : "Error";
          const message = error instanceof Error ? error.message : String(error);
          logEvent({
            level: "error",
            event: "guardrail_execution_failed",
            context: { itemId, actionType: approvedAction.actionType, errorClass },
          });
          recordSystemEvent(
            auditLog,
            decidedBy,
            "guardrail_executed",
            "failure",
            { actionType: approvedAction.actionType, targetSystem: approvedAction.targetSystem.name, realExecution: true, errorClass },
            item.correlationId
          );
          sendJson(res, 200, { itemId, status: item.status, result, executed: false, realExecution: true, error: errorCode, message });
        }
      }

      // ADR-012: Docker/dev-superset is the one target this environment has
      // direct, unprivileged control over — a local dev container, no new
      // credential, no production system touched.
      if (approvedAction.actionType === "restart_service" && approvedAction.targetSystem.name === "dev-superset") {
        await executeReal(async () => {
          const outcome = await restartSupersetContainer();
          const seconds = Math.round(outcome.waitedMs / 1000);
          return outcome.confirmedHealthy
            ? { confirmed: true, detail: `confirmed healthy in ${seconds}s` }
            : { confirmed: false, detail: `not confirmed healthy after ${seconds}s — check Docker directly` };
        }, "DOCKER_RESTART_FAILED");
        return;
      }

      // Same mechanism as dev-superset above, second target: dev-postgres is
      // also a local dev container this environment can genuinely restart.
      if (approvedAction.actionType === "restart_service" && approvedAction.targetSystem.name === "dev-postgres") {
        await executeReal(async () => {
          const outcome = await restartPostgresContainer();
          const seconds = Math.round(outcome.waitedMs / 1000);
          return outcome.confirmedHealthy
            ? { confirmed: true, detail: `confirmed reachable in ${seconds}s` }
            : { confirmed: false, detail: `not confirmed reachable after ${seconds}s — check Docker directly` };
        }, "DOCKER_RESTART_FAILED");
        return;
      }

      // ADR-013: Postgres backend termination on orders-db — the second real
      // execution exception, same confined-blast-radius reasoning: only
      // rolls back the terminated backend's own uncommitted transaction.
      if (approvedAction.actionType === "kill_postgres_backend") {
        const pidMatch = approvedAction.targetSystem.name.match(/^backend (\d+)/);
        const pid = pidMatch ? Number(pidMatch[1]) : NaN;
        await executeReal(async () => {
          const outcome = await terminatePostgresBackend(pid);
          return outcome.confirmedTerminated
            ? { confirmed: true, detail: `confirmed backend ${pid} terminated` }
            : { confirmed: false, detail: `backend ${pid} still active after ${Math.round(outcome.waitedMs / 1000)}s — investigate manually` };
        }, "PG_TERMINATE_FAILED");
        return;
      }

      // Real execution: restart the one real, reversible service this process
      // has. This never varies by actionType — the recommendation (what
      // approvedAction says should happen) is real and source-specific per
      // ADR-010; execution stays this one honest stand-in, since no real
      // write access to SQL Server/IIS exists in this environment, except
      // the ADR-012/ADR-013 exceptions handled above.
      // standInFor makes that explicit in the response rather than letting
      // "executed: true" imply the real target system was actually touched.
      stopMonitoringInternal();
      const taskId = startMonitoringInternal();
      pending.executedAt = new Date().toISOString();
      const standInFor = `${approvedAction.actionType} on ${approvedAction.targetSystem.name}`;
      logEvent({
        level: "info",
        event: "guardrail_executed",
        context: { itemId, actionType: approvedAction.actionType, taskId, standInFor },
      });
      recordSystemEvent(
        auditLog,
        session.username,
        "guardrail_executed",
        "success",
        { actionType: approvedAction.actionType, targetSystem: approvedAction.targetSystem.name, taskId, standInFor },
        item.correlationId
      );

      sendJson(res, 200, {
        itemId,
        status: item.status,
        result,
        executed: true,
        executedAt: pending.executedAt,
        taskId,
        standInFor,
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
      if (error instanceof AlreadyDecidedError) {
        sendJson(res, 409, { error: "ALREADY_DECIDED", message: error.message, executed: false });
        return;
      }
      throw error;
    }
  }

  // Pure record-keeping, not a confidence mechanism: whether an approved fix
  // actually resolved the incident is recorded to the durable audit trail so
  // it exists if this system ever accumulates enough real history to
  // honestly calibrate confidence thresholds against outcomes — see the
  // confidence-calibration discussion this route exists to answer. Does NOT
  // feed back into any prompt, threshold, or future confidence score; each
  // call to analyzeIncidentRootCause() remains a stateless, evidence-only
  // analysis with no memory of past outcomes. Human-attested, not inferred —
  // nothing here automatically checks whether an incident's condition
  // actually cleared. Append-only like the rest of the audit trail
  // (ADR-005): a later correction (marked resolved, later found to have
  // recurred) adds a new entry rather than overwriting the old one; readers
  // take the most recent entry for a correlationId as current.
  if (req.method === "POST" && url.pathname === "/api/guardrail/outcome") {
    const session = requireSession(req, res);
    if (!session) return;

    let body: { correlationId?: unknown; outcome?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch (error) {
      sendJson(res, 400, {
        error: "INVALID_JSON_BODY",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const { correlationId, outcome } = body;
    if (typeof correlationId !== "string" || !correlationId || (outcome !== "resolved" && outcome !== "recurred")) {
      sendJson(res, 400, {
        error: "MISSING_FIELDS",
        message: "correlationId (string) and outcome ('resolved' | 'recurred') are required.",
      });
      return;
    }

    const confirmedAt = new Date().toISOString();
    recordSystemEvent(
      auditLog,
      session.username,
      "outcome_confirmed",
      outcome === "resolved" ? "success" : "failure",
      { outcome, confirmedBy: session.username },
      correlationId
    );
    logEvent({
      level: "info",
      event: "outcome_confirmed",
      context: { correlationId, outcome, confirmedBy: session.username },
    });

    sendJson(res, 200, { correlationId, outcome, confirmedBy: session.username, confirmedAt });
    return;
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

  if (req.method === "POST" && url.pathname === "/api/demo/restart-server") {
    // Demo-only, human-triggered restart for Beat 6 of the Expo demo — proves
    // the audit trail survives a real process restart, live, without a
    // terminal. Absent from any non-demo run: isDemoModeEnabled() only
    // returns true when the shell command that launched this process was
    // prefixed with DEMO_MODE=true (see scripts/demoSupervisor.mjs and
    // .claude/skills/demo-start/SKILL.md) — it's never set in .env, so a
    // real deployment can't reach this route no matter who is logged in.
    // Falling through to the generic 404 below when disabled means the
    // route is indistinguishable from not existing, not just rejected.
    if (!requireSession(req, res)) return;
    if (!isDemoModeEnabled()) {
      sendJson(res, 404, { error: "NOT_FOUND", path: url.pathname });
      return;
    }
    logEvent({ level: "info", event: "demo_restart_requested", context: {} });
    const payload = JSON.stringify({ restarting: true });
    res.writeHead(200, { "Content-Type": "application/json" });
    // Exit only after the response is actually flushed to the client, so the
    // dashboard's fetch() resolves with this 200 before the process dies —
    // a bare process.exit() right after writeHead risks the connection
    // closing before the body reaches the browser.
    res.end(payload, () => process.exit(0));
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
  // Demo-only: a demo restart wipes the in-memory SessionStore, forcing a
  // fresh login (including a fresh TOTP code) every time. Rather than making
  // the presenter ask for one by hand, push it themselves the moment this
  // process is reachable again — fires on every demo-mode boot, not just a
  // restart, so it also covers the very first boot of a demo session. Gated
  // behind isDemoModeEnabled() exactly like POST /api/demo/restart-server, so
  // it's structurally absent whenever DEMO_MODE isn't set (never written to
  // .env, only ever passed as a shell prefix on the demo launch command).
  if (isDemoModeEnabled()) {
    const code = generateTotpCode(MFA_TOTP_SECRET, Date.now());
    notifyOperators({
      actionType: "Auth_Code",
      incidentId: "demo-startup",
      summary:
        `CoreOps demo server is back up. Fresh TOTP code: ${code}. ` +
        `This code is only valid for about 30 seconds from generation — if it doesn't work by the time you read this, ask for a fresh one.`,
      // Green-flavored: no elevated accent (default priority) — this isn't a
      // problem, it's a delivered credential, so it shouldn't look urgent.
      priority: "default",
      tags: "white_check_mark",
    }).catch(() => {
      // notifyOperators() already logs and never rethrows on its own failure —
      // this catch exists only so an unexpected rejection can't take down a
      // server that otherwise started up successfully.
    });
  }
});
