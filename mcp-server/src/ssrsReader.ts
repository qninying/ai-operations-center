import { executionLogFixture, SsrsExecutionLogRow } from "./ssrsFixtures.js";
import { SUPPORTED_SSRS_QUERIES, SupportedSsrsQuery, ReadSsrsInput } from "./ssrsTypes.js";
import { querySsrsExecutionLog, SsrsLiveSourceUnavailableError } from "./ssrsLiveSource.js";
import { UpstreamCallFailedError } from "./reliability/withReliability.js";
import { CircuitOpenError } from "./reliability/circuitBreaker.js";
import { logEvent } from "./observability/logger.js";

// Orchestration for the SSRS read path, mirroring dmvReader.ts exactly: try a real
// query against SSRS's ExecutionLog3 view first; on any known live-source failure,
// fall back to fixture data rather than erroring out. Every response is tagged with
// which source actually served it, capped to MAX_RESULTS rows regardless of path.
// Kept separate from index.ts's MCP wiring so it's directly unit testable, and the
// live source is injectable so tests never need a real ReportServer database.
//
// Handles the same two boundary cases as the DMV path, for the same reasons: an
// empty-string reportPath filter is normalized to "no filter" rather than matching
// nothing, and a genuine zero-result outcome gets a friendly message and a logged
// warn event rather than an unexplained empty array.

export { SUPPORTED_SSRS_QUERIES };
export type { ReadSsrsInput };

const MAX_RESULTS = 3;

export class UnsupportedSsrsQueryError extends Error {
  readonly errorClass = "UnsupportedSsrsQueryError" as const;

  constructor(readonly queryName: string) {
    super(
      `Unsupported SSRS query "${queryName}". Supported: ${SUPPORTED_SSRS_QUERIES.join(", ")}.`
    );
    this.name = "UnsupportedSsrsQueryError";
  }
}

export interface SsrsReadResult {
  source: "live" | "fallback";
  rows: SsrsExecutionLogRow[];
  message?: string;
}

function isSupportedSsrsQuery(queryName: string): queryName is SupportedSsrsQuery {
  return (SUPPORTED_SSRS_QUERIES as readonly string[]).includes(queryName);
}

function readFixture(input: ReadSsrsInput): SsrsExecutionLogRow[] {
  const rows = executionLogFixture;
  if (input.reportPath === undefined) {
    return rows;
  }
  return rows.filter((row) => row.report_path === input.reportPath);
}

function isKnownLiveSourceFailure(error: unknown): boolean {
  return (
    error instanceof SsrsLiveSourceUnavailableError ||
    error instanceof UpstreamCallFailedError ||
    error instanceof CircuitOpenError
  );
}

// An empty-string filter is almost certainly a caller mistake, not a deliberate
// request to match nothing — normalize it to "no filter" rather than punishing the
// caller with a silently empty result.
function normalizeInput(input: ReadSsrsInput): ReadSsrsInput {
  if (input.reportPath === "") {
    logEvent({
      level: "warn",
      event: "ssrs_empty_filter_normalized",
      context: { queryName: input.queryName, field: "reportPath" },
    });
    return { ...input, reportPath: undefined };
  }
  return input;
}

function buildResult(
  source: "live" | "fallback",
  rows: SsrsExecutionLogRow[],
  input: ReadSsrsInput
): SsrsReadResult {
  const shaped = rows.slice(0, MAX_RESULTS);

  if (shaped.length === 0) {
    logEvent({
      level: "warn",
      event: "ssrs_zero_results",
      context: { queryName: input.queryName, reportPath: input.reportPath ?? null, source },
    });
    return {
      source,
      rows: shaped,
      message: input.reportPath
        ? `No matching execution log rows found for report "${input.reportPath}".`
        : "No matching execution log rows found.",
    };
  }

  return { source, rows: shaped };
}

export async function readSsrsExecutionLog(
  input: ReadSsrsInput,
  liveSource: (input: ReadSsrsInput) => Promise<SsrsExecutionLogRow[]> = querySsrsExecutionLog
): Promise<SsrsReadResult> {
  if (!isSupportedSsrsQuery(input.queryName)) {
    throw new UnsupportedSsrsQueryError(input.queryName);
  }

  const normalizedInput = normalizeInput(input);

  try {
    const rows = await liveSource(normalizedInput);
    return buildResult("live", rows, normalizedInput);
  } catch (error) {
    if (!isKnownLiveSourceFailure(error)) {
      throw error;
    }
    return buildResult("fallback", readFixture(normalizedInput), normalizedInput);
  }
}
