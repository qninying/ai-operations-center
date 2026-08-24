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

export function createCoreOpsMcpServer(): McpServer {
  const server = new McpServer({
    name: "coreops-mcp-server",
    version: "0.1.0",
  });

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
    async ({ dmvName, databaseName }) => {
      try {
        const { source, rows } = await readDmv({ dmvName, databaseName });
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
          return {
            isError: true,
            content: [{ type: "text", text: `UnsupportedDmvError: ${error.message}` }],
          };
        }
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
    async ({ queryName, targetDatabase }) => ({
      content: [
        {
          type: "text",
          text: `NOT_IMPLEMENTED: run_diagnostic_query is a stub. Received queryName="${queryName}", targetDatabase="${targetDatabase}". No query was executed.`,
        },
      ],
    })
  );

  return server;
}
