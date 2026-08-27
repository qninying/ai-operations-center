import { dmExecRequestsFixture, DmvExecRequestRow } from "./dmvFixtures.js";
import { SUPPORTED_DMVS, SupportedDmv, ReadDmvInput } from "./dmvTypes.js";
import { queryLiveDmv, LiveSourceUnavailableError } from "./dmvLiveSource.js";
import { UpstreamCallFailedError } from "./reliability/withReliability.js";
import { CircuitOpenError } from "./reliability/circuitBreaker.js";
import { logEvent } from "./observability/logger.js";

// Orchestration for R3 (result shaping + substitutions): try a real SQL Server query
// first; on any known live-source failure, fall back to fixture data rather than
// erroring out. Every response is tagged with which source actually served it, and
// capped to MAX_RESULTS rows regardless of path. Kept separate from index.ts's MCP
// wiring so it's directly unit testable, and the live source is injectable so tests
// never need a real database.
//
// Also handles two boundary cases gracefully rather than silently: an empty-string
// databaseName filter (almost certainly a caller mistake, e.g. an empty form field)
// is normalized to "no filter" rather than matching nothing; and a genuine
// zero-result outcome gets a friendly `message` and a logged warn event, rather than
// an unexplained empty array.

export { SUPPORTED_DMVS };
export type { ReadDmvInput };

// Raised from 3 alongside the fixture expansion (ADR-010) so the fallback
// path's now-10 realistic blocking scenarios all survive shaping — still a
// reasonable cap for a real live query on a busy server.
const MAX_RESULTS = 15;

export class UnsupportedDmvError extends Error {
  readonly errorClass = "UnsupportedDmvError" as const;

  constructor(readonly dmvName: string) {
    super(
      `Unsupported DMV "${dmvName}". Supported: ${SUPPORTED_DMVS.join(", ")}.`
    );
    this.name = "UnsupportedDmvError";
  }
}

export interface DmvReadResult {
  source: "live" | "fallback";
  rows: DmvExecRequestRow[];
  message?: string;
}

function isSupportedDmv(dmvName: string): dmvName is SupportedDmv {
  return (SUPPORTED_DMVS as readonly string[]).includes(dmvName);
}

function readFixture(input: ReadDmvInput): DmvExecRequestRow[] {
  const rows = dmExecRequestsFixture;
  if (input.databaseName === undefined) {
    return rows;
  }
  return rows.filter((row) => row.database_name === input.databaseName);
}

function isKnownLiveSourceFailure(error: unknown): boolean {
  return (
    error instanceof LiveSourceUnavailableError ||
    error instanceof UpstreamCallFailedError ||
    error instanceof CircuitOpenError
  );
}

// An empty-string filter is almost certainly a caller mistake, not a deliberate
// request to match nothing — normalize it to "no filter" rather than punishing the
// caller with a silently empty result.
function normalizeInput(input: ReadDmvInput): ReadDmvInput {
  if (input.databaseName === "") {
    logEvent({
      level: "warn",
      event: "dmv_empty_filter_normalized",
      context: { dmvName: input.dmvName, field: "databaseName" },
    });
    return { ...input, databaseName: undefined };
  }
  return input;
}

function buildResult(
  source: "live" | "fallback",
  rows: DmvExecRequestRow[],
  input: ReadDmvInput
): DmvReadResult {
  const shaped = rows.slice(0, MAX_RESULTS);

  if (shaped.length === 0) {
    logEvent({
      level: "warn",
      event: "dmv_zero_results",
      context: { dmvName: input.dmvName, databaseName: input.databaseName ?? null, source },
    });
    return {
      source,
      rows: shaped,
      message: input.databaseName
        ? `No matching rows found for database "${input.databaseName}".`
        : "No matching rows found.",
    };
  }

  return { source, rows: shaped };
}

export async function readDmv(
  input: ReadDmvInput,
  liveSource: (input: ReadDmvInput) => Promise<DmvExecRequestRow[]> = queryLiveDmv
): Promise<DmvReadResult> {
  if (!isSupportedDmv(input.dmvName)) {
    throw new UnsupportedDmvError(input.dmvName);
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
