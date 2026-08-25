// Demo asset for project-blueprint/demo-script.md — not a test, not an HTTP route.
// Run with:
//   npx tsx mcp-server/src/demoSsrsExecutionLog.ts
//
// This is the real reporting-service integration: readSsrsExecutionLog() reads
// SSRS's actual ExecutionLog3 view (SSRS logs every report run straight into a SQL
// Server database, so this needs no SSRS-native API and no Windows Server VM — the
// same real Azure SQL connection the DMV path already uses). Live-first, honestly
// tagged "fallback" if the connection isn't up right now, same pattern as
// dmvReader.ts. This is the genuine "a reporting service is connected to CoreOps"
// demo -- see mcp-server/dev-superset/README.md for what the Superset container
// does and does not prove, which is a different thing.

import { readSsrsExecutionLog } from "./ssrsReader.js";

const result = await readSsrsExecutionLog({ queryName: "ExecutionLog3" });

console.log(`Source: ${result.source}`);
console.log(`Rows: ${result.rows.length}`);
console.log(JSON.stringify(result, null, 2));
