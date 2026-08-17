// Minimal structured JSON logger per this repo's Observability Framework
// (timestamp/level/service/event/context, one JSON object per line).
//
// Deliberate deviation from the framework's general "logs go to stdout" rule:
// this writes to stderr instead, via console.error. Reason: index.ts's stdio MCP
// transport reserves stdout exclusively for the JSON-RPC protocol stream — writing
// anything else to stdout would corrupt it. The existing
// `console.error("...connected over stdio")` in index.ts follows the same
// constraint. httpServer.ts has no such restriction but uses this logger too, for
// one consistent log stream regardless of transport.

export type LogLevel = "info" | "warn" | "error";

export interface LogEventInput {
  level: LogLevel;
  event: string;
  service?: string;
  context?: Record<string, unknown>;
}

export function logEvent(input: LogEventInput): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level: input.level,
    service: input.service ?? "aiops-mcp-server",
    event: input.event,
    context: input.context ?? {},
  });
  console.error(line);
}
