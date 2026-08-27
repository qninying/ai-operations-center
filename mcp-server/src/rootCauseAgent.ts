import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { CircuitBreaker } from "./reliability/circuitBreaker.js";
import { withReliability } from "./reliability/withReliability.js";
import { logEvent } from "./observability/logger.js";
import { readConfidenceThreshold } from "./confidenceThresholds.js";

// R1 (project-blueprint/requirements.md) / STORY-003: the Root Cause Analysis Agent,
// per architecture.md's Components table — "Asks Claude to explain why the
// correlated failures happened, using live read-only queries against the affected
// systems as evidence instead of guessing from telemetry alone." Tech: Claude Sonnet
// 5 (Anthropic API) + MCP Tool Gateway (read path).
//
// Three properties this module is responsible for (R1's own acceptance bar):
// 1. Evidence-grounded — real evidence rows go into the prompt, not a description.
// 2. Attributed — the response cites which evidence IDs it actually used.
// 3. Non-fabricated when thin — no evidence, no API call; a low-confidence result is
//    returned deterministically rather than asking the model to invent one. And a
//    genuine upstream failure (timeout, 5xx) surfaces as a typed error, never as a
//    fabricated "confident" answer standing in for a call that didn't succeed.

export interface EvidenceItem {
  id: string;
  source: string;
  data: unknown;
}

export interface Incident {
  id: string;
  description: string;
  evidence: EvidenceItem[];
}

export interface Claim {
  text: string;
  evidenceId: string;
  field: string;
  value: string;
}

export interface RootCauseResult {
  rootCause: string;
  confidence: number; // 0-100
  evidenceIdsUsed: string[];
  insufficientEvidence: boolean;
  claims: Claim[];
}

export interface AnalyzeOptions {
  // Injection point for tests. Defaults to a real Anthropic Messages API call.
  callModel?: (prompt: string) => Promise<string>;
}

export class MissingApiKeyError extends Error {
  readonly errorClass = "MissingApiKeyError" as const;
  constructor() {
    super("ANTHROPIC_API_KEY is not set.");
    this.name = "MissingApiKeyError";
  }
}

export class MalformedResponseError extends Error {
  readonly errorClass = "MalformedResponseError" as const;
  constructor(cause: unknown) {
    super(
      `Claude's response did not match the expected root-cause schema: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = "MalformedResponseError";
    this.cause = cause;
  }
}

// LLM calls run longer than a DB round trip, so a longer timeout than R5's 10s SQL
// Server budget; fewer retries, since a slow/failing model call is expensive to
// repeat and this is a read-reasoning path, not a critical write.
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 4_000;
const MODEL = "claude-sonnet-5";

// Below this, the result is treated as "insufficient evidence" rather than a usable
// root cause — matches the threshold the prompt itself instructs the model to use,
// but enforced here too so a misbehaving response can't claim otherwise.
// REQ-014: configurable via CONFIDENCE_THRESHOLD_INSUFFICIENT — see confidenceThresholds.ts.
const INSUFFICIENT_CONFIDENCE_THRESHOLD = readConfidenceThreshold("CONFIDENCE_THRESHOLD_INSUFFICIENT", 30);

// Shared module-level breaker so failures accumulate across every call, not just
// within one call's own retries — same pattern as dmvLiveSource.ts's dmvCircuitBreaker.
const rootCauseCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
});

const ClaimSchema = z.object({
  text: z.string().min(1),
  evidenceId: z.string(),
  field: z.string(),
  value: z.string(),
});

const RootCauseResponseSchema = z.object({
  rootCause: z.string().min(1),
  confidence: z.number().min(0).max(100),
  evidenceIdsUsed: z.array(z.string()),
  // Optional and defaulted: this is the first time the model has been asked
  // for this field, so a response that omits it (or an older cached
  // prompt/response shape) degrades to today's behavior, not a hard failure.
  claims: z.array(ClaimSchema).optional().default([]),
});

function insufficientEvidenceResult(reason: string): RootCauseResult {
  return {
    rootCause: `Insufficient evidence: ${reason}`,
    confidence: 0,
    evidenceIdsUsed: [],
    insufficientEvidence: true,
    claims: [],
  };
}

function buildPrompt(incident: Incident): string {
  return [
    `Incident: ${incident.description}`,
    ``,
    `Evidence (cite these IDs in evidenceIdsUsed if you use them):`,
    ...incident.evidence.map((e) => `- [${e.id}] (${e.source}): ${JSON.stringify(e.data)}`),
    ``,
    `Based only on the evidence above, respond with a JSON object matching exactly:`,
    `{"rootCause": string, "confidence": number (0-100), "evidenceIdsUsed": string[], "claims": [{"text": string, "evidenceId": string, "field": string, "value": string}]}`,
    `For each specific fact in your rootCause that is drawn directly from one field of one piece of evidence — not inference or synthesis across multiple items — add an entry to claims naming the exact evidenceId, the literal field name from that evidence's data, and its literal value as a string. Only include claims you can point to one literal field for; do not force synthesis or inference into a claim.`,
    `If the evidence does not support a confident root cause, set confidence below ${INSUFFICIENT_CONFIDENCE_THRESHOLD} and explain why in rootCause.`,
    `Respond with JSON only, no other text.`,
  ].join("\n");
}

function parseResponse(text: string): z.infer<typeof RootCauseResponseSchema> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new MalformedResponseError(error);
  }
  const parsed = RootCauseResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new MalformedResponseError(parsed.error);
  }
  return parsed.data;
}

async function defaultCallModel(prompt: string): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === "text"
  );
  if (!textBlock) {
    throw new MalformedResponseError("Claude response contained no text block");
  }
  return textBlock.text;
}

// Throws MissingApiKeyError (checked before any attempt, never retried — matches
// dmvLiveSource.ts's LiveSourceUnavailableError pattern), UpstreamTimeoutError /
// UpstreamCallFailedError / CircuitOpenError (from withReliability), or
// MalformedResponseError. Only a genuine no-evidence input short-circuits to a
// deterministic result without calling the model at all.
export async function analyzeIncidentRootCause(
  incident: Incident,
  options: AnalyzeOptions = {}
): Promise<RootCauseResult> {
  if (incident.evidence.length === 0) {
    logEvent({
      level: "warn",
      event: "root_cause_insufficient_evidence",
      context: { incidentId: incident.id },
    });
    return insufficientEvidenceResult("no evidence was supplied for this incident");
  }

  const callModel = options.callModel;
  if (!callModel && !process.env.ANTHROPIC_API_KEY) {
    throw new MissingApiKeyError();
  }
  const modelFn = callModel ?? defaultCallModel;

  const text = await withReliability(() => modelFn(buildPrompt(incident)), {
    timeoutMs: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    baseDelayMs: BASE_DELAY_MS,
    maxDelayMs: MAX_DELAY_MS,
    circuitBreaker: rootCauseCircuitBreaker,
  });

  const parsed = parseResponse(text);
  const result: RootCauseResult = {
    rootCause: parsed.rootCause,
    confidence: parsed.confidence,
    evidenceIdsUsed: parsed.evidenceIdsUsed,
    insufficientEvidence: parsed.confidence < INSUFFICIENT_CONFIDENCE_THRESHOLD,
    claims: parsed.claims,
  };

  logEvent({
    level: "info",
    event: "root_cause_analyzed",
    context: {
      incidentId: incident.id,
      confidence: result.confidence,
      insufficientEvidence: result.insufficientEvidence,
      evidenceCount: incident.evidence.length,
    },
  });

  return result;
}
