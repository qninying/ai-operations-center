// The tool/resource registrations CoreOps' MCP Tool Gateway exposes, factored out
// of index.ts (ADR-001) so both transports — stdio (index.ts, local dev) and
// StreamableHTTP (httpMcpServer.ts, the deployed gateway) — sit in front of the
// exact same handlers. ADR-001's own consequences section is explicit that the
// transport decision is "additive at the transport layer only" and must not
// duplicate or fork this logic.
//
// Returns a fresh McpServer each call — required for the HTTP transport's
// stateless mode (one server+transport pair per request, per the MCP SDK's own
// stateless StreamableHTTP example), and harmless for stdio, which only ever
// calls this once.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readDmv, SUPPORTED_DMVS, UnsupportedDmvError } from "./dmvReader.js";
import { readSsrsExecutionLog, SUPPORTED_SSRS_QUERIES, UnsupportedSsrsQueryError } from "./ssrsReader.js";
import { sendMcpLog } from "./observability/mcpLog.js";
import { makeProgressEmitter } from "./observability/mcpProgress.js";
import { resolveWithinRoots, PathOutsideRootsError, NoRootsDeclaredError } from "./security/rootsEnforcement.js";
import { readDiagnosticLogFile } from "./diagnosticLogReader.js";
import { checkPostgresBackendBlocked } from "./pgBackendStatusSource.js";
import { UpstreamTimeoutError } from "./reliability/withReliability.js";
import { CircuitOpenError } from "./reliability/circuitBreaker.js";

export function createCoreOpsMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "coreops-mcp-server",
      version: "0.1.0",
    },
    // Without declaring this, a connected client silently drops every
    // notifications/message this file sends — no error either side, the
    // message just never arrives. See observability/mcpLog.ts.
    {
      capabilities: { logging: {} },
    }
  );

  // Found live, 2026-08-30: this resource hardcoded dmExecRequestsFixture and
  // claimed "STUB" in its own description, even though read_sql_server_dmv (the
  // equivalent tool, just below) has called the real live readDmv() path since
  // day one — a live SQL Server connection was never actually missing, this
  // resource just never used it. Fixed to call the same readDmv() the tool
  // uses, including its real fixture-fallback on a genuine connection failure —
  // the response's own "source" field says which happened on any given read,
  // so a client is never left guessing whether this is live or fallback data.
  server.registerResource(
    "sql-server-dmv-exec-requests",
    "dmv://sql-server/exec-requests",
    {
      title: "SQL Server DMV: sys.dm_exec_requests",
      description:
        "Read-only snapshot of currently executing SQL Server requests, including blocking sessions and wait types. Live-queried against the real SQL Server connection; falls back to fixture data only if that connection genuinely fails, reported honestly via this response's own \"source\" field.",
      mimeType: "application/json",
    },
    async (uri) => {
      const { source, rows } = await readDmv({ dmvName: "sys.dm_exec_requests" });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ dmvName: "sys.dm_exec_requests", source, rowCount: rows.length, rows }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "read_sql_server_dmv",
    {
      title: "Read SQL Server DMV",
      description:
        "Reads a supported SQL Server Dynamic Management View (DMV) and returns matching rows as structured JSON. Read-only: performs no write of any kind.",
      inputSchema: {
        dmvName: z
          .enum(SUPPORTED_DMVS)
          .describe(`DMV to read. Supported: ${SUPPORTED_DMVS.join(", ")}.`),
        databaseName: z
          .string()
          .optional()
          .describe("Optional database name to filter returned rows by."),
      },
    },
    async ({ dmvName, databaseName }, extra) => {
      const correlationId = crypto.randomUUID();
      sendMcpLog(server, "info", "mcp_tool_invocation_started", {
        correlationId,
        tool: "read_sql_server_dmv",
        dmvName,
        databaseName: databaseName ?? null,
      });

      // Real total: maxAttempts is withReliability's own actual retry cap, not
      // a guess. null when the caller attached no progressToken -- every tool
      // in this file shares this same opt-in emitter instead of building its
      // own notification object inline, the way this one used to.
      const progress = makeProgressEmitter(extra);
      const onAttempt = progress
        ? (attempt: number, maxAttempts: number) =>
            progress.send(attempt, maxAttempts, `Querying ${dmvName} (attempt ${attempt} of ${maxAttempts})`)
        : undefined;
      try {
        sendMcpLog(server, "info", "mcp_external_call_started", {
          correlationId,
          tool: "read_sql_server_dmv",
          target: "sql_server_dmv",
        });
        const startedAt = Date.now();
        const { source, rows } = await readDmv({ dmvName, databaseName }, undefined, onAttempt);
        sendMcpLog(server, "info", "mcp_external_call_finished", {
          correlationId,
          tool: "read_sql_server_dmv",
          target: "sql_server_dmv",
          durationMs: Date.now() - startedAt,
          source,
          rowCount: rows.length,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ dmvName, source, rowCount: rows.length, rows }, null, 2),
            },
          ],
        };
      } catch (error) {
        if (error instanceof UnsupportedDmvError) {
          sendMcpLog(server, "warning", "mcp_tool_denied", {
            correlationId,
            tool: "read_sql_server_dmv",
            errorClass: error.name,
            reason: error.message,
          });
          return {
            isError: true,
            content: [{ type: "text", text: `UnsupportedDmvError: ${error.message}` }],
          };
        }
        sendMcpLog(server, "error", "mcp_tool_error", {
          correlationId,
          tool: "read_sql_server_dmv",
          errorClass: error instanceof Error ? error.name : "Error",
        });
        throw error;
      }
    }
  );

  // Same fix as the DMV resource above, same date: this resource hardcoded
  // executionLogFixture while read_ssrs_execution_log already called the real
  // live path — as of 2026-08-29's real ExecutionLog3 table
  // (seedSsrsExecutionLog.ts), that live path is no longer fixture-only either.
  server.registerResource(
    "ssrs-execution-log",
    "ssrs://report-server/execution-log",
    {
      title: "SSRS ExecutionLog3: recent non-success report executions",
      description:
        "Read-only snapshot of recent SSRS report executions that did not complete successfully, including timeouts and processing errors. Live-queried against the real ExecutionLog3 table; falls back to fixture data only if that connection genuinely fails, reported honestly via this response's own \"source\" field.",
      mimeType: "application/json",
    },
    async (uri) => {
      const { source, rows } = await readSsrsExecutionLog({ queryName: "ExecutionLog3" });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ queryName: "ExecutionLog3", source, rowCount: rows.length, rows }, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    "read_ssrs_execution_log",
    {
      title: "Read SSRS execution log",
      description:
        "Reads recent SSRS report executions that did not complete successfully (timeouts, processing errors) from ExecutionLog3, returned as structured JSON. Read-only: performs no write of any kind.",
      inputSchema: {
        queryName: z
          .enum(SUPPORTED_SSRS_QUERIES)
          .describe(`SSRS query to read. Supported: ${SUPPORTED_SSRS_QUERIES.join(", ")}.`),
        reportPath: z
          .string()
          .optional()
          .describe("Optional report path to filter returned rows by, e.g. \"/Finance/MonthlyRevenue\"."),
      },
    },
    async ({ queryName, reportPath }, extra) => {
      const correlationId = crypto.randomUUID();
      sendMcpLog(server, "info", "mcp_tool_invocation_started", {
        correlationId,
        tool: "read_ssrs_execution_log",
        queryName,
        reportPath: reportPath ?? null,
      });

      // This tool never had progress support at all before -- same real-total
      // shape as read_sql_server_dmv now that querySsrsExecutionLog()/
      // readSsrsExecutionLog() both accept onAttempt.
      const progress = makeProgressEmitter(extra);
      const onAttempt = progress
        ? (attempt: number, maxAttempts: number) =>
            progress.send(attempt, maxAttempts, `Querying ${queryName} (attempt ${attempt} of ${maxAttempts})`)
        : undefined;

      try {
        sendMcpLog(server, "info", "mcp_external_call_started", {
          correlationId,
          tool: "read_ssrs_execution_log",
          target: "ssrs_execution_log",
        });
        const startedAt = Date.now();
        const { source, rows } = onAttempt
          ? await readSsrsExecutionLog({ queryName, reportPath }, undefined, onAttempt)
          : await readSsrsExecutionLog({ queryName, reportPath });
        sendMcpLog(server, "info", "mcp_external_call_finished", {
          correlationId,
          tool: "read_ssrs_execution_log",
          target: "ssrs_execution_log",
          durationMs: Date.now() - startedAt,
          source,
          rowCount: rows.length,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ queryName, source, rowCount: rows.length, rows }, null, 2),
            },
          ],
        };
      } catch (error) {
        if (error instanceof UnsupportedSsrsQueryError) {
          sendMcpLog(server, "warning", "mcp_tool_denied", {
            correlationId,
            tool: "read_ssrs_execution_log",
            errorClass: error.name,
            reason: error.message,
          });
          return {
            isError: true,
            content: [{ type: "text", text: `UnsupportedSsrsQueryError: ${error.message}` }],
          };
        }
        sendMcpLog(server, "error", "mcp_tool_error", {
          correlationId,
          tool: "read_ssrs_execution_log",
          errorClass: error instanceof Error ? error.name : "Error",
        });
        throw error;
      }
    }
  );

  server.registerTool(
    "run_diagnostic_query",
    {
      title: "Run diagnostic query (stub)",
      description:
        "STUB: will run a named, pre-approved read-only diagnostic query against a monitored SQL Server instance. Not yet implemented — returns a not-implemented result without contacting any system.",
      inputSchema: {
        queryName: z.string().describe("Name of the pre-approved diagnostic query to run."),
        targetDatabase: z.string().describe("Database to run the diagnostic query against."),
      },
    },
    async ({ queryName, targetDatabase }) => {
      sendMcpLog(server, "info", "mcp_tool_invocation_started", {
        correlationId: crypto.randomUUID(),
        tool: "run_diagnostic_query",
        queryName,
        targetDatabase,
      });
      return {
        content: [
          {
            type: "text",
            text: `NOT_IMPLEMENTED: run_diagnostic_query is a stub. Received queryName="${queryName}", targetDatabase="${targetDatabase}". No query was executed.`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "read_diagnostic_log_file",
    {
      title: "Read diagnostic log file",
      description:
        "Reads a local diagnostic log file (e.g. a SQL Server error log excerpt) and returns its most recent lines as structured JSON. Read-only: performs no write of any kind. The file must resolve to a real path inside a root the connected client has declared via MCP roots — anything else, including a path that only reaches outside those roots via \"..\" traversal or a symlink, is denied.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute or relative path to the diagnostic log file to read."),
        maxLines: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Maximum number of most-recent lines to return (default 200)."),
      },
    },
    async ({ path, maxLines }) => {
      const correlationId = crypto.randomUUID();
      sendMcpLog(server, "info", "mcp_tool_invocation_started", {
        correlationId,
        tool: "read_diagnostic_log_file",
        requestedPath: path,
      });

      let realPath: string;
      try {
        realPath = await resolveWithinRoots(server, path);
      } catch (error) {
        if (error instanceof PathOutsideRootsError || error instanceof NoRootsDeclaredError) {
          sendMcpLog(server, "warning", "mcp_tool_denied", {
            correlationId,
            tool: "read_diagnostic_log_file",
            requestedPath: path,
            errorClass: error.name,
            reason: error.message,
          });
          return {
            isError: true,
            content: [{ type: "text", text: `${error.name}: ${error.message}` }],
          };
        }
        sendMcpLog(server, "error", "mcp_tool_error", {
          correlationId,
          tool: "read_diagnostic_log_file",
          errorClass: error instanceof Error ? error.name : "Error",
        });
        throw error;
      }

      try {
        sendMcpLog(server, "info", "mcp_external_call_started", {
          correlationId,
          tool: "read_diagnostic_log_file",
          target: "diagnostic_log_file",
        });
        const startedAt = Date.now();
        const result = await readDiagnosticLogFile(realPath, { maxLines });
        sendMcpLog(server, "info", "mcp_external_call_finished", {
          correlationId,
          tool: "read_diagnostic_log_file",
          target: "diagnostic_log_file",
          durationMs: Date.now() - startedAt,
          lineCount: result.lines.length,
          truncatedBySize: result.truncatedBySize,
          truncatedByLineCount: result.truncatedByLineCount,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ path: realPath, ...result }, null, 2),
            },
          ],
        };
      } catch (error) {
        sendMcpLog(server, "error", "mcp_tool_error", {
          correlationId,
          tool: "read_diagnostic_log_file",
          errorClass: error instanceof Error ? error.name : "Error",
        });
        throw error;
      }
    }
  );

  // The one tool in this server that reasons rather than looks up. Every other
  // tool here returns raw evidence for the CALLER to judge; this one asks the
  // connected CLIENT's own model to make the judgment call, via real MCP
  // sampling (sampling/createMessage) -- never a direct API call from this
  // process. That split is deliberate: no API key, no model name, and no
  // billing relationship belongs in this server at all -- both live entirely
  // on the client side of the protocol boundary, same as any other MCP server
  // that wants reasoning without owning a model subscription.
  //
  // Scoped to the two real evidence sources this server can itself observe
  // (SQL Server blocking chains, SSRS failed report runs) -- the same sources
  // read_sql_server_dmv/read_ssrs_execution_log already expose. Postgres,
  // Cloud, and Docker incidents are real in the dashboard's own process but
  // this MCP server has no plumbing to them, so this tool doesn't pretend to
  // cover incidents it can't actually see.
  server.registerTool(
    "triage_active_incidents",
    {
      title: "Triage active incidents",
      description:
        "Fetches real SQL Server blocking-chain and SSRS failed-report evidence itself, then asks the connected client's own model (via MCP sampling) to judge which one is most urgent to look at first and why. Read-only: performs no write of any kind. Requires the client to support MCP sampling -- returns a clear, evidence-backed result (never empty, never a crash) if it doesn't or the request is declined.",
      inputSchema: {},
    },
    async (_args, extra) => {
      const correlationId = crypto.randomUUID();
      sendMcpLog(server, "info", "mcp_tool_invocation_started", {
        correlationId,
        tool: "triage_active_incidents",
      });

      // This tool aggregates strictly more real work than either single-source
      // tool above it -- both their fetches, plus a fetch-count phase of its
      // own, plus the sampling wait -- so it's the one with the most progress
      // ticks under any real network condition, not just when Azure happens to
      // need retries.
      const progress = makeProgressEmitter(extra);
      const TOTAL_FETCHES = 2; // real: exactly the two evidence sources below, not a guess
      let fetchesDone = 0;
      const dmvOnAttempt = progress
        ? (attempt: number, maxAttempts: number) =>
            progress.send(attempt, maxAttempts, `Querying SQL Server DMV (attempt ${attempt} of ${maxAttempts})`)
        : undefined;
      const ssrsOnAttempt = progress
        ? (attempt: number, maxAttempts: number) =>
            progress.send(attempt, maxAttempts, `Querying SSRS ExecutionLog3 (attempt ${attempt} of ${maxAttempts})`)
        : undefined;
      function markFetchDone(label: string): void {
        fetchesDone += 1;
        progress?.send(fetchesDone, TOTAL_FETCHES, `Fetched ${label} evidence (${fetchesDone} of ${TOTAL_FETCHES} sources done)`);
      }

      // 1. Real data, fetched by this tool itself -- no model call involved yet.
      // Same mcp_external_call_started/finished vocabulary read_sql_server_dmv
      // and read_ssrs_execution_log already use for these exact two calls --
      // this tool just makes both instead of one, so it logs both.
      async function fetchWithLogging<T>(
        target: "sql_server_dmv" | "ssrs_execution_log",
        run: () => Promise<T>
      ): Promise<T> {
        sendMcpLog(server, "info", "mcp_external_call_started", { correlationId, tool: "triage_active_incidents", target });
        const callStartedAt = Date.now();
        try {
          const value = await run();
          sendMcpLog(server, "info", "mcp_external_call_finished", {
            correlationId,
            tool: "triage_active_incidents",
            target,
            durationMs: Date.now() - callStartedAt,
          });
          return value;
        } catch (error) {
          sendMcpLog(server, "error", "mcp_tool_error", {
            correlationId,
            tool: "triage_active_incidents",
            target,
            errorClass: error instanceof Error ? error.name : "Error",
          });
          throw error;
        }
      }

      const dmvPromise = fetchWithLogging("sql_server_dmv", () =>
        dmvOnAttempt ? readDmv({ dmvName: "sys.dm_exec_requests" }, undefined, dmvOnAttempt) : readDmv({ dmvName: "sys.dm_exec_requests" })
      ).finally(() => markFetchDone("SQL Server"));
      const ssrsPromise = fetchWithLogging("ssrs_execution_log", () =>
        ssrsOnAttempt ? readSsrsExecutionLog({ queryName: "ExecutionLog3" }, undefined, ssrsOnAttempt) : readSsrsExecutionLog({ queryName: "ExecutionLog3" })
      ).finally(() => markFetchDone("SSRS"));
      const [dmvResult, ssrsResult] = await Promise.allSettled([dmvPromise, ssrsPromise]);
      const blocked =
        dmvResult.status === "fulfilled"
          ? dmvResult.value.rows.filter((row) => row.blocking_session_id && row.blocking_session_id !== 0)
          : [];
      const failedReports = ssrsResult.status === "fulfilled" ? ssrsResult.value.rows : [];

      if (blocked.length === 0 && failedReports.length === 0) {
        sendMcpLog(server, "info", "mcp_tool_invocation_finished", {
          correlationId,
          tool: "triage_active_incidents",
          outcome: "no_incidents",
        });
        return {
          content: [
            { type: "text", text: "No active SQL blocking sessions or failed SSRS report executions right now -- nothing to triage." },
          ],
        };
      }

      // 2. Client capability check, up front -- a clean, evidence-backed
      // degraded result if this client never declared sampling support, not a
      // failed request.
      if (!server.server.getClientCapabilities()?.sampling) {
        sendMcpLog(server, "warning", "mcp_sampling_unsupported", { correlationId, tool: "triage_active_incidents" });
        return {
          content: [
            {
              type: "text",
              text: `This client doesn't support MCP sampling, so no AI judgment could be made. Raw evidence: ${blocked.length} blocked SQL session(s), ${failedReports.length} failed SSRS report(s). Review manually.`,
            },
          ],
        };
      }

      const evidenceText = [
        ...blocked.map(
          (row) =>
            `SQL: session ${row.session_id} blocked by session ${row.blocking_session_id} on ${row.database_name}, waiting ${row.total_elapsed_time_ms}ms${row.wait_type ? ` (${row.wait_type})` : ""}.`
        ),
        ...failedReports.map(
          (row) => `SSRS: report ${row.report_path} -- ${row.status}, run by ${row.user_name} at ${row.time_start}.`
        ),
      ].join("\n");

      // Same mcp_external_call_started/finished vocabulary the fetches above
      // and every other tool in this file use -- a sampling request is an
      // external call too (to the client), it just doesn't get its own
      // one-off event names.
      sendMcpLog(server, "info", "mcp_external_call_started", { correlationId, tool: "triage_active_incidents", target: "mcp_sampling" });
      // Genuinely unknown total: there's no way to know how long the client's
      // model will take or how many tokens it'll return before it responds --
      // createMessage() isn't streaming, so there's no real intermediate count
      // to report either. One honest tick with no total, saying so plainly,
      // rather than fabricating a percentage during a black-box wait.
      progress?.send(1, undefined, "Waiting for the client's model to respond (no way to know how long this takes)");
      const startedAt = Date.now();
      try {
        // <<< THE REQUEST LEAVES THIS PROCESS HERE. This is the one line in
        // this server that ever asks for a model completion -- and it asks
        // the CLIENT, over the already-connected MCP transport, not any AI
        // provider directly. No API key, no model name: the client owns both
        // and reports back which model it actually used in the result.
        const result = await server.server.createMessage({
          systemPrompt:
            "You are triaging real, currently-active operations incidents for a DBA. Given the evidence, judge which single incident is most urgent to look at first and explain why in 2-3 sentences. Cite the specific evidence you're relying on. Do not invent evidence you weren't given.",
          messages: [
            {
              role: "user",
              content: { type: "text", text: `Current evidence:\n${evidenceText}\n\nWhich incident is most urgent, and why?` },
            },
          ],
          maxTokens: 300,
        });
        const durationMs = Date.now() - startedAt;
        sendMcpLog(server, "info", "mcp_external_call_finished", {
          correlationId,
          tool: "triage_active_incidents",
          target: "mcp_sampling",
          durationMs,
          model: result.model,
        });

        const text = result.content.type === "text" ? result.content.text : "(client returned a non-text response)";
        return { content: [{ type: "text", text }] };
      } catch (error) {
        // The client either doesn't truly support sampling despite declaring
        // it, or a human declined the request (MCP's own human-in-the-loop
        // expectation for sampling) -- either way, a real evidence-backed
        // result, never a crash and never silence. Logged as mcp_tool_error
        // (the same "error caught" event every other catch in this file
        // uses, with the same stable-error-class requirement) even though,
        // unlike those, this one deliberately does NOT rethrow -- the caught
        // error becomes a graceful degraded result, not a fatal one.
        const durationMs = Date.now() - startedAt;
        sendMcpLog(server, "warning", "mcp_tool_error", {
          correlationId,
          tool: "triage_active_incidents",
          target: "mcp_sampling",
          durationMs,
          errorClass: error instanceof Error ? error.name : "Error",
        });
        return {
          content: [
            {
              type: "text",
              text: `The client declined or failed to sample a judgment (${error instanceof Error ? error.message : String(error)}). Raw evidence: ${blocked.length} blocked SQL session(s), ${failedReports.length} failed SSRS report(s). Review manually.`,
            },
          ],
        };
      }
    }
  );

  // Reads a real dev-postgres backend's current status by pid -- see
  // pgBackendStatusSource.ts for the pooled connection, the bound
  // parameterized query, and the timeout/retry/circuit-breaker wrapping.
  // This registration's own job is narrower: never let a raw failure escape
  // as a thrown error or leak host/credential detail to the caller.
  server.registerTool(
    "check_postgres_backend_blocked",
    {
      title: "Check Postgres backend blocked status",
      description:
        "Given a real Postgres backend process id (pid) on dev-postgres, reports whether it currently exists, what it's doing, and which other backend pids (if any) are blocking it. Read-only: performs no write of any kind.",
      inputSchema: {
        pid: z.number().int().positive().describe("The real Postgres backend process id to check."),
      },
    },
    async ({ pid }, extra) => {
      const correlationId = crypto.randomUUID();
      sendMcpLog(server, "info", "mcp_tool_invocation_started", {
        correlationId,
        tool: "check_postgres_backend_blocked",
        pid,
      });

      const progress = makeProgressEmitter(extra);
      const onAttempt = progress
        ? (attempt: number, maxAttempts: number) =>
            progress.send(attempt, maxAttempts, `Checking backend ${pid} (attempt ${attempt} of ${maxAttempts})`)
        : undefined;

      sendMcpLog(server, "info", "mcp_external_call_started", {
        correlationId,
        tool: "check_postgres_backend_blocked",
        target: "postgres_backend_status",
      });
      const startedAt = Date.now();
      try {
        const status = await checkPostgresBackendBlocked(pid, onAttempt);
        sendMcpLog(server, "info", "mcp_external_call_finished", {
          correlationId,
          tool: "check_postgres_backend_blocked",
          target: "postgres_backend_status",
          durationMs: Date.now() - startedAt,
          found: status.found,
          blockedByCount: status.blockedBy.length,
        });
        return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
      } catch (error) {
        // Deliberately never the raw caught error/driver message here, in the
        // log, or in what's returned -- a raw pg connection error can carry
        // the real host/port (e.g. "connect ECONNREFUSED 127.0.0.1:5434").
        // Only a stable, safe class name and a generic message cross this
        // boundary, on both the log line and the response the caller sees.
        const durationMs = Date.now() - startedAt;
        let errorClass: string;
        let publicMessage: string;
        if (error instanceof UpstreamTimeoutError) {
          errorClass = "TimeoutError";
          publicMessage = `Checking backend ${pid} timed out.`;
        } else if (error instanceof CircuitOpenError) {
          errorClass = "UpstreamUnavailable";
          publicMessage = "Postgres has failed repeatedly recently; not attempting another call right now.";
        } else {
          errorClass = "UpstreamUnavailable";
          publicMessage = `Could not reach Postgres to check backend ${pid}.`;
        }
        sendMcpLog(server, "warning", "mcp_tool_error", {
          correlationId,
          tool: "check_postgres_backend_blocked",
          target: "postgres_backend_status",
          durationMs,
          errorClass,
        });
        return { isError: true, content: [{ type: "text", text: `${errorClass}: ${publicMessage}` }] };
      }
    }
  );

  return server;
}
