import "./loadEnv.js";
import sql from "mssql";

// Demo/dev tooling only — deliberately creates a real SQL Server blocking scenario
// against the connected database, so a live demo has something incident-shaped to
// show instead of an idle system. This is the ONE place in this repo that writes to
// a monitored SQL Server; everything else (the MCP Tool Gateway, the AI
// recommendation path) is read-only by construction. Not part of the app — run by
// hand: `npx tsx src/seedBlockingScenario.ts [holdSeconds]`.
//
// Session A opens a transaction and holds an exclusive lock; Session B concurrently
// tries to touch the same row and blocks on it — the same shape of scenario this
// repo's fixture data has modeled since day one (session 61 blocked by 52).
//
// Idempotent in the sense that matters here: table creation is guarded
// (IF NOT EXISTS), and the only "side effect" is one row's status field flipping
// between two values — running this repeatedly doesn't create duplicate rows or
// accumulate state, just repeats the same transient lock.

const CONNECT_TIMEOUT_MS = 10_000;
// Session B's UPDATE sits waiting on the server for however long Session A holds
// its lock — its own client-side request timeout must comfortably exceed the
// longest hold time this script supports, or it gives up before ever seeing the
// unblock. Bug caught by actually running this against a real blocking scenario:
// the first attempt used the same 10s value as connectionTimeout, which was
// shorter than the 25s hold used in that run, so Session B silently timed out
// client-side without ever completing.
const REQUEST_TIMEOUT_MS = 120_000;
const REQUIRED_ENV_VARS = ["SQLSERVER_HOST", "SQLSERVER_DATABASE", "SQLSERVER_USER", "SQLSERVER_PASSWORD"] as const;

function readConfig(): sql.config {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing env vars: ${missing.join(", ")}. Fill in mcp-server/.env first.`);
  }
  return {
    server: process.env.SQLSERVER_HOST!,
    database: process.env.SQLSERVER_DATABASE!,
    user: process.env.SQLSERVER_USER!,
    password: process.env.SQLSERVER_PASSWORD!,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
    options: { trustServerCertificate: false, encrypt: true },
  };
}

async function ensureDemoTable(pool: sql.ConnectionPool): Promise<void> {
  await pool.request().query(`
    IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'DemoOrders')
    BEGIN
      CREATE TABLE dbo.DemoOrders (
        id INT PRIMARY KEY,
        status NVARCHAR(50) NOT NULL
      );
      INSERT INTO dbo.DemoOrders (id, status) VALUES (1, 'pending');
    END
  `);
}

async function holdLock(pool: sql.ConnectionPool, holdMs: number): Promise<void> {
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  const txRequest = new sql.Request(transaction);
  console.log("[Session A] Opening a transaction, taking an exclusive lock on DemoOrders id=1...");
  await txRequest.query(`UPDATE dbo.DemoOrders SET status = 'processing' WHERE id = 1;`);
  console.log(
    `[Session A] Lock held for ${holdMs / 1000}s. Query sys.dm_exec_requests now (or run the demo) to see the block.`
  );
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  await transaction.commit();
  console.log("[Session A] Transaction committed, lock released.");
}

async function attemptBlockedWrite(pool: sql.ConnectionPool): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 2_000)); // let Session A take its lock first
  console.log("[Session B] Attempting to update the same row — this will block until Session A commits...");
  const start = Date.now();
  await pool.request().query(`UPDATE dbo.DemoOrders SET status = 'shipped' WHERE id = 1;`);
  console.log(`[Session B] Unblocked after ${Date.now() - start}ms.`);
}

async function main(): Promise<void> {
  const holdSeconds = Number(process.argv[2]) || 20;
  const config = readConfig();

  const poolA = new sql.ConnectionPool(config);
  const poolB = new sql.ConnectionPool(config);
  await poolA.connect();
  await poolB.connect();

  try {
    await ensureDemoTable(poolA);
    await Promise.all([holdLock(poolA, holdSeconds * 1000), attemptBlockedWrite(poolB)]);
  } finally {
    await poolA.close();
    await poolB.close();
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
