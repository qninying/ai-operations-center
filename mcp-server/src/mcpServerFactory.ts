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
import { dmExecRequestsFixture } from "./dmvFixtures.js";
import { readDmv, SUPPORTED_DMVS, UnsupportedDmvError } from "./dmvReader.js";
import { executionLogFixture } from "./ssrsFixtures.js";
import { readSsrsExecutionLog, SUPPORTED_SSRS_QUERIES, UnsupportedSsrsQueryError } from "./ssrsReader.js";
import { sendMcpLog } from "./observability/mcpLog.js";
import { resolveWithinRoots, PathOutsideRootsError, NoRootsDeclaredError } from "./security/rootsEnforcement.js";
import { readDiagnosticLogFile } from "./diagnosticLogReader.js";

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

  server.registerResource(
    "sql-server-dmv-exec-requests",
    "dmv://sql-server/exec-requests",
    {
      title: "SQL Server DMV: sys.dm_exec_requests",
      description:
        "Read-only snapshot of currently executing SQL Server requests, including blocking sessions and wait types. STUB: served from fixture data until a live SQL Server connection is wired in.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(dmExecRequestsFixture, null, 2),
        },
      ],
    })
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

      const progressToken = extra._meta?.progressToken;
      // Progress notifications are opt-in per MCP spec: only build and pass a
      // callback when the caller actually attached a progressToken, so a client
      // that never asked for updates gets the exact same call path as before.
      const onAttempt =
        progressToken === undefined
          ? undefined
          : (attempt: number, maxAttempts: number) =>
              void extra.sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: attempt,
                  total: maxAttempts,
                  message: `Querying ${dmvName} (attempt ${attempt} of ${maxAttempts})`,
                },
              });
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

  server.registerResource(
    "ssrs-execution-log",
    "ssrs://report-server/execution-log",
    {
      title: "SSRS ExecutionLog3: recent non-success report executions",
      description:
        "Read-only snapshot of recent SSRS report executions that did not complete successfully, including timeouts and processing errors. STUB: served from fixture data until a live SSRS ReportServer database connection is wired in.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(executionLogFixture, null, 2),
        },
      ],
    })
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
    async ({ queryName, reportPath }) => {
      const correlationId = crypto.randomUUID();
      sendMcpLog(server, "info", "mcp_tool_invocation_started", {
        correlationId,
        tool: "read_ssrs_execution_log",
        queryName,
        reportPath: reportPath ?? null,
      });

      try {
        sendMcpLog(server, "info", "mcp_external_call_started", {
          correlationId,
          tool: "read_ssrs_execution_log",
          target: "ssrs_execution_log",
        });
        const startedAt = Date.now();
        const { source, rows } = await readSsrsExecutionLog({ queryName, reportPath });
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

  return server;
}
