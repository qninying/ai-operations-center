import "./loadEnv.js";
import sql from "mssql";

// Demo/dev tooling only — creates a real dbo.ExecutionLog3 table (SSRS's own real
// Reporting Services catalog schema, at least the columns ssrsLiveSource.ts's
// ExecutionLog3 query actually selects) and seeds it with real rows, so
// SSRS_REPORTSERVER_DATABASE has a genuine table to query instead of throwing
// SsrsLiveSourceUnavailableError for a missing env var. Not part of the app —
// run by hand: `npx tsx src/seedSsrsExecutionLog.ts`.
//
// This repo never had a real SSRS/Reporting Services deployment to point at —
// ExecutionLog3 normally lives in the separate ReportServer catalog database a
// real SSRS install creates for itself. Azure SQL Database's single-database
// model means provisioning an actual second database is its own Azure Portal
// action, not something this script can do — so this deliberately reuses the
// SAME database SQLSERVER_DATABASE already points at (see .env:
// SSRS_REPORTSERVER_DATABASE=coreops-demo), adding one real table to it rather
// than a whole new database. This is real data once inserted, same honesty
// pattern as seedCloudDiagnostics.ts/seedPostgresBlockingScenario.ts — seeded,
// not fabricated in the response path.
//
// Idempotent: fixed InstanceName values per row, DELETE-then-INSERT rather than
// an unconditional accumulate — running this twice leaves the same 2 rows, not 4.
// Row content deliberately matches ssrsFixtures.ts's existing 2 trimmed rows
// (/Finance/MonthlyRevenue, /Ops/DailyIncidentSummary) so the dashboard shows the
// same narrative whether SSRS is reachable (this table) or falls back to fixture
// data — a presenter who rehearsed against the fixture sees the same story live.

const REQUIRED_ENV_VARS = [
  "SQLSERVER_HOST",
  "SSRS_REPORTSERVER_DATABASE",
  "SQLSERVER_USER",
  "SQLSERVER_PASSWORD",
] as const;

interface SeedRow {
  instanceName: string;
  itemPath: string;
  userName: string;
  status: string;
  timeStart: string;
  timeEnd: string;
  timeDataRetrievalMs: number;
  timeProcessingMs: number;
  timeRenderingMs: number;
}

const SEED_ROWS: SeedRow[] = [
  {
    instanceName: "demo-exec-finance-monthly-revenue",
    itemPath: "/Finance/MonthlyRevenue",
    userName: "svc-report-runner",
    status: "rsProcessingAborted",
    timeStart: "2026-08-24T08:12:03Z",
    timeEnd: "2026-08-24T08:12:41Z",
    timeDataRetrievalMs: 4200,
    timeProcessingMs: 33800,
    timeRenderingMs: 0,
  },
  {
    instanceName: "demo-exec-ops-daily-incident-summary",
    itemPath: "/Ops/DailyIncidentSummary",
    userName: "quincy",
    status: "rsCannotSetProcessingProperty",
    timeStart: "2026-08-24T07:55:41Z",
    timeEnd: "2026-08-24T07:55:44Z",
    timeDataRetrievalMs: 0,
    timeProcessingMs: 2900,
    timeRenderingMs: 0,
  },
];

function readConfig(): sql.config {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing env vars: ${missing.join(", ")}. Fill in mcp-server/.env first.`);
  }
  return {
    server: process.env.SQLSERVER_HOST!,
    database: process.env.SSRS_REPORTSERVER_DATABASE!,
    user: process.env.SQLSERVER_USER!,
    password: process.env.SQLSERVER_PASSWORD!,
    connectionTimeout: 10_000,
    requestTimeout: 15_000,
    options: { trustServerCertificate: false, encrypt: true },
  };
}

async function ensureExecutionLog3Table(pool: sql.ConnectionPool): Promise<void> {
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'ExecutionLog3' AND schema_id = SCHEMA_ID('dbo'))
    BEGIN
      CREATE TABLE dbo.ExecutionLog3 (
        InstanceName NVARCHAR(260) NOT NULL PRIMARY KEY,
        ItemPath NVARCHAR(425) NOT NULL,
        UserName NVARCHAR(260) NOT NULL,
        Status NVARCHAR(50) NOT NULL,
        TimeStart DATETIME2 NOT NULL,
        TimeEnd DATETIME2 NULL,
        TimeDataRetrieval INT NULL,
        TimeProcessing INT NULL,
        TimeRendering INT NULL
      );
    END
  `);
}

async function seedRows(pool: sql.ConnectionPool): Promise<void> {
  for (const row of SEED_ROWS) {
    const request = pool.request();
    request.input("instanceName", sql.NVarChar, row.instanceName);
    request.input("itemPath", sql.NVarChar, row.itemPath);
    request.input("userName", sql.NVarChar, row.userName);
    request.input("status", sql.NVarChar, row.status);
    request.input("timeStart", sql.DateTime2, new Date(row.timeStart));
    request.input("timeEnd", sql.DateTime2, new Date(row.timeEnd));
    request.input("timeDataRetrieval", sql.Int, row.timeDataRetrievalMs);
    request.input("timeProcessing", sql.Int, row.timeProcessingMs);
    request.input("timeRendering", sql.Int, row.timeRenderingMs);
    await request.query(`
      DELETE FROM dbo.ExecutionLog3 WHERE InstanceName = @instanceName;
      INSERT INTO dbo.ExecutionLog3
        (InstanceName, ItemPath, UserName, Status, TimeStart, TimeEnd, TimeDataRetrieval, TimeProcessing, TimeRendering)
      VALUES
        (@instanceName, @itemPath, @userName, @status, @timeStart, @timeEnd, @timeDataRetrieval, @timeProcessing, @timeRendering);
    `);
    console.log(`Seeded ${row.itemPath} — ${row.status}`);
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  const pool = new sql.ConnectionPool(config);
  await pool.connect();
  try {
    await ensureExecutionLog3Table(pool);
    await seedRows(pool);
    console.log(`Done. dbo.ExecutionLog3 in ${config.database} has ${SEED_ROWS.length} real rows.`);
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
