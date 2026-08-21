import "./loadEnv.js";
import sql from "mssql";
import { BlobServiceClient } from "@azure/storage-blob";

// Demo/dev tooling only — warms up the two external dependencies before a live demo:
// SQL Server (the free tier auto-pauses when idle and can take up to ~60-90s to wake
// on the first query) and Azure Blob Storage (doesn't cold-start, but checked anyway
// so a demo never discovers a bad connection string live). Not part of the app — run
// by hand: `npx tsx src/warmup.ts`. Used by the demo-start skill.
//
// Deliberately does NOT go through queryLiveDmv()/dmvReader.ts — those exist to serve
// the app, with fixture-fallback behavior that would make this script report "OK"
// even when SQL Server is genuinely unreachable. This talks to SQL Server directly,
// the same way seedBlockingScenario.ts does, so a failure here is never masked.

const SQL_REQUIRED_ENV_VARS = ["SQLSERVER_HOST", "SQLSERVER_DATABASE", "SQLSERVER_USER", "SQLSERVER_PASSWORD"] as const;
const SQL_WARMUP_BUDGET_MS = 90_000;
const SQL_ATTEMPT_TIMEOUT_MS = 15_000;
const SQL_RETRY_DELAY_MS = 5_000;

interface WarmupResult {
  ok: boolean;
  message: string;
}

async function warmupSqlServer(): Promise<WarmupResult> {
  const missing = SQL_REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    return { ok: false, message: `Missing env vars: ${missing.join(", ")}. Fill in mcp-server/.env first.` };
  }

  const config: sql.config = {
    server: process.env.SQLSERVER_HOST!,
    database: process.env.SQLSERVER_DATABASE!,
    user: process.env.SQLSERVER_USER!,
    password: process.env.SQLSERVER_PASSWORD!,
    connectionTimeout: SQL_ATTEMPT_TIMEOUT_MS,
    requestTimeout: SQL_ATTEMPT_TIMEOUT_MS,
    options: { trustServerCertificate: false, encrypt: true },
  };

  const deadline = Date.now() + SQL_WARMUP_BUDGET_MS;
  let lastError: unknown;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    const pool = new sql.ConnectionPool(config);
    try {
      console.log(`[SQL Server] Attempt ${attempt}...`);
      await pool.connect();
      await pool.request().query("SELECT 1 AS ok");
      await pool.close();
      return { ok: true, message: `Connected on attempt ${attempt}.` };
    } catch (error) {
      lastError = error;
      await pool.close().catch(() => {});
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`[SQL Server] Not ready yet (${msg}). Retrying in ${SQL_RETRY_DELAY_MS / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(SQL_RETRY_DELAY_MS, remaining)));
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  return { ok: false, message: `Gave up after ${attempt} attempts (${SQL_WARMUP_BUDGET_MS / 1000}s budget): ${msg}` };
}

async function warmupBlobStorage(): Promise<WarmupResult> {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const container = process.env.AZURE_STORAGE_CONTAINER;
  if (!connectionString || !container) {
    return { ok: false, message: "AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_CONTAINER not set in mcp-server/.env." };
  }

  try {
    const client = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = client.getContainerClient(container);
    const exists = await containerClient.exists();
    if (!exists) {
      return { ok: false, message: `Container "${container}" does not exist.` };
    }
    return { ok: true, message: `Container "${container}" reachable.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  console.log("Warming up SQL Server — this can take up to 90s if the free tier is paused...");
  const sqlResult = await warmupSqlServer();
  console.log(sqlResult.ok ? `[SQL Server] OK — ${sqlResult.message}` : `[SQL Server] FAILED — ${sqlResult.message}`);

  console.log("\nChecking Azure Blob Storage...");
  const blobResult = await warmupBlobStorage();
  console.log(blobResult.ok ? `[Blob Storage] OK — ${blobResult.message}` : `[Blob Storage] FAILED — ${blobResult.message}`);

  if (!sqlResult.ok || !blobResult.ok) {
    console.log("\nWarmup incomplete — see failures above before demoing.");
    process.exit(1);
  }
  console.log("\nBoth dependencies are warm and reachable.");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
