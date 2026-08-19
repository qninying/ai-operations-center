import { BlobServiceClient } from "@azure/storage-blob";
import { CircuitBreaker } from "./reliability/circuitBreaker.js";
import { withReliability } from "./reliability/withReliability.js";

// Real Azure Blob Storage I/O for STORY-007 / REQ-008 — the cloud-service counterpart
// to dmvLiveSource.ts's SQL Server path. Same shape: env-var-configured connection,
// timeout + capped retry + circuit breaker, and a typed unavailability error thrown
// (never retried, since missing config won't change between attempts) rather than
// treated as a transient failure. Returns the parsed blob content typed as
// CloudDiagnosticRecord[] at the call site — same level of rigor as
// dmvLiveSource.ts's generic mssql cast; the caller is responsible for real runtime
// validation before trusting the data as evidence, same as recommendationService.ts's
// DmvExecRequestRowSchema does for the SQL Server path.

const REQUIRED_ENV_VARS = ["AZURE_STORAGE_CONNECTION_STRING", "AZURE_STORAGE_CONTAINER"] as const;

// Same R5-style reliability budget as dmvLiveSource.ts: 10s timeout per attempt, 3
// retries with exponential backoff, circuit breaker after 5 failures in a 60s window
// with a 30s cooldown. A separate module-level breaker from the DMV path's — a cloud
// storage outage and a SQL Server outage are independent failure domains and
// shouldn't trip each other's circuit.
const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 4_000;
const DEFAULT_BLOB_NAME = "diagnostics.json";

const blobCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
});

// Shape of the diagnostic export this connector expects to find in blob storage —
// e.g. an SSIS/SQL Server ops export written by an existing pipeline. Not yet
// zod-validated here; that lands when this is wired into recommendationService.ts,
// matching the DMV path's convention of validating at the point evidence is trusted.
export interface CloudDiagnosticRecord {
  timestamp: string;
  service: string;
  severity: string;
  message: string;
}

export interface ReadCloudBlobInput {
  blobName?: string;
}

export class CloudSourceUnavailableError extends Error {
  readonly errorClass = "CloudSourceUnavailableError" as const;

  constructor(readonly missingEnvVars: string[]) {
    super(
      `Azure Blob Storage connection not configured. Missing env vars: ${missingEnvVars.join(", ")}.`
    );
    this.name = "CloudSourceUnavailableError";
  }
}

function readConnectionConfig(): { connectionString: string; container: string } {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new CloudSourceUnavailableError(missing);
  }

  return {
    connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING!,
    container: process.env.AZURE_STORAGE_CONTAINER!,
  };
}

async function streamToString(readable: NodeJS.ReadableStream | undefined): Promise<string> {
  if (!readable) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of readable as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function downloadBlob(
  blobName: string,
  config: { connectionString: string; container: string }
): Promise<CloudDiagnosticRecord[]> {
  const serviceClient = BlobServiceClient.fromConnectionString(config.connectionString);
  const containerClient = serviceClient.getContainerClient(config.container);
  const blobClient = containerClient.getBlobClient(blobName);
  const downloadResponse = await blobClient.download();
  const content = await streamToString(downloadResponse.readableStreamBody);
  // A malformed export is a data-format failure, not a connectivity one, but this
  // layer doesn't distinguish the two — like a query error on the SQL Server path,
  // it's just another attempt failure to withReliability, retried and ultimately
  // surfaced as UpstreamCallFailedError with the SyntaxError as its cause.
  return JSON.parse(content) as CloudDiagnosticRecord[];
}

// Throws CloudSourceUnavailableError (missing config, no attempt made),
// UpstreamCallFailedError (all retries exhausted — covers connection failure,
// timeout, and invalid data format alike), or CircuitOpenError (breaker open, no
// attempt made). Never returns a partial/best-effort result.
export async function queryLiveCloudBlob(
  input: ReadCloudBlobInput = {}
): Promise<CloudDiagnosticRecord[]> {
  const config = readConnectionConfig();
  const blobName = input.blobName ?? DEFAULT_BLOB_NAME;

  return withReliability(() => downloadBlob(blobName, config), {
    timeoutMs: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    baseDelayMs: BASE_DELAY_MS,
    maxDelayMs: MAX_DELAY_MS,
    circuitBreaker: blobCircuitBreaker,
  });
}
