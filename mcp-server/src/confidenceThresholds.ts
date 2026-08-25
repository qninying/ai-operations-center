// REQ-014: "The system must allow configuration of confidence thresholds for
// actions." Three modules each hardcoded their own threshold constant —
// rootCauseAgent.ts's INSUFFICIENT_CONFIDENCE_THRESHOLD (30),
// diagnosticsGatherer.ts's GATHER_THRESHOLD (80), escalationService.ts's
// ESCALATION_THRESHOLD (60). Same shape, same validation need, three occurrences
// — this repo's own extraction threshold (CLAUDE.md's Modular Composition Rule:
// "the same 5+ lines of non-trivial logic appear in three places, lift them").
//
// Deliberately stricter than the PORT-style `Number(process.env.X ?? default)`
// pattern used elsewhere in this file's siblings (httpServer.ts, httpMcpServer.ts):
// a malformed PORT fails loudly and obviously (the server never binds). A
// malformed confidence threshold would silently become NaN, and every
// `confidence >= NaN` / `confidence < NaN` comparison is always false —
// escalationService.ts's escalation gate, for one, would then never fire again,
// with no error anywhere pointing at why. These three thresholds gate real
// governance behavior (escalation to a human, whether a differential gets
// gathered, whether a root cause counts as usable at all), so bad config here
// fails fast at startup instead of silently changing behavior at runtime.

export class InvalidConfidenceThresholdError extends Error {
  readonly errorClass = "InvalidConfidenceThresholdError" as const;

  constructor(
    readonly envVarName: string,
    readonly rawValue: string
  ) {
    super(
      `${envVarName} is set to "${rawValue}", which is not a valid confidence threshold. ` +
        `Must be a finite number between 0 and 100, or unset to use the default.`
    );
    this.name = "InvalidConfidenceThresholdError";
  }
}

function isValidThreshold(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

// Reads a confidence threshold from the named env var, falling back to
// defaultValue when unset or empty (the common case — every deployment today
// runs on defaults, same behavior as before this option existed). Throws
// InvalidConfidenceThresholdError for a value that's set but not a finite
// number in [0, 100] — never silently falls back to the default for a
// malformed value, since that would mask a real typo in production config.
export function readConfidenceThreshold(envVarName: string, defaultValue: number): number {
  const raw = process.env[envVarName];
  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!isValidThreshold(parsed)) {
    throw new InvalidConfidenceThresholdError(envVarName, raw);
  }
  return parsed;
}
