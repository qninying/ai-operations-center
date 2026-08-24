import "./loadEnv.js";
import { BlobServiceClient } from "@azure/storage-blob";
import type { CloudDiagnosticRecord } from "./cloudBlobSource.js";

// Demo/dev tooling only — uploads a fresh diagnostics.json to the real Azure Blob
// container that queryLiveCloudBlob() reads, so /api/cloud-recommendation (and the
// escalation notification it can trigger via evaluateEscalation()) reflects a
// genuinely different issue on each run instead of whatever content was last
// uploaded by hand. Not part of the app — run by hand:
// `npx tsx src/seedCloudDiagnostics.ts [scenario]`.
//
// Found live: every "CoreOps: escalation" push notification carried the same
// near-identical "SSIS package load exceeded expected duration" root cause —
// traced to diagnostics.json in blob storage never having been updated since it
// was first uploaded, so every real call read the exact same single-row evidence
// and Claude's analysis of unchanging evidence was, correctly, nearly unchanging
// too. That's not a bug in the recommendation path (evidence-grounded analysis is
// supposed to be stable on identical evidence) — the fix is varying the evidence,
// same idea as seedBlockingScenario.ts on the SQL Server side.
//
// Idempotent in the sense that matters here: BlockBlobClient.upload() is an
// unconditional overwrite (no append, no versioning assumed), so running this
// twice with the same scenario leaves the blob in the same state, not a duplicate.

const REQUIRED_ENV_VARS = ["AZURE_STORAGE_CONNECTION_STRING", "AZURE_STORAGE_CONTAINER"] as const;
const BLOB_NAME = "diagnostics.json";

const SCENARIOS: Record<string, () => CloudDiagnosticRecord[]> = {
  "ssis-slow-load": () => [
    {
      timestamp: new Date().toISOString(),
      service: "SSIS",
      severity: "warning",
      message: "Package load exceeded expected duration (18m vs 5m baseline) on the nightly ETL run.",
    },
  ],
  "ssrs-render-timeout": () => [
    {
      timestamp: new Date().toISOString(),
      service: "SSRS",
      severity: "error",
      message:
        "Report rendering timed out after 120s for 'QuarterlyClaims.rdl'; snapshot cache miss forced a live data-source query.",
    },
  ],
  "sqlagent-job-failed": () => [
    {
      timestamp: new Date().toISOString(),
      service: "SQLAgent",
      severity: "critical",
      message:
        "Job 'Nightly_Reconciliation' step 3 failed: primary key violation on staging.Transactions, 4th consecutive failure.",
    },
  ],
  "windows-disk-critical": () => [
    {
      timestamp: new Date().toISOString(),
      service: "WindowsServer",
      severity: "critical",
      message: "Volume D:\\ on SQLPRD02 at 96% capacity; SSIS temp buffer writes failing intermittently.",
    },
  ],
  "cloud-storage-latency": () => [
    {
      timestamp: new Date().toISOString(),
      service: "AzureBlob",
      severity: "warning",
      message:
        "Read latency to the diagnostics container p95 up to 4.2s (baseline 300ms) over the last hour; downstream SSIS package reads from this container are slower than usual.",
    },
  ],
};

const SCENARIO_NAMES = Object.keys(SCENARIOS);

function pickScenario(arg: string | undefined): { name: string; records: CloudDiagnosticRecord[] } {
  if (arg) {
    const build = SCENARIOS[arg];
    if (!build) {
      throw new Error(`Unknown scenario "${arg}". Known scenarios: ${SCENARIO_NAMES.join(", ")}`);
    }
    return { name: arg, records: build() };
  }
  const name = SCENARIO_NAMES[Math.floor(Math.random() * SCENARIO_NAMES.length)];
  return { name, records: SCENARIOS[name]() };
}

function readConfig(): { connectionString: string; container: string } {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing env vars: ${missing.join(", ")}. Fill in mcp-server/.env first.`);
  }
  return {
    connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING!,
    container: process.env.AZURE_STORAGE_CONTAINER!,
  };
}

async function main(): Promise<void> {
  const { name, records } = pickScenario(process.argv[2]);
  const config = readConfig();

  const serviceClient = BlobServiceClient.fromConnectionString(config.connectionString);
  const containerClient = serviceClient.getContainerClient(config.container);
  const blockBlobClient = containerClient.getBlockBlobClient(BLOB_NAME);

  const content = JSON.stringify(records, null, 2);
  await blockBlobClient.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: "application/json" },
  });

  console.log(`Uploaded scenario "${name}" (of: ${SCENARIO_NAMES.join(", ")}) to ${config.container}/${BLOB_NAME}:`);
  console.log(content);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
