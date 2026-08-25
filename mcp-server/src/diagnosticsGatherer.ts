import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { CircuitBreaker } from "./reliability/circuitBreaker.js";
import { withReliability } from "./reliability/withReliability.js";
import { logEvent } from "./observability/logger.js";
import type { Incident, RootCauseResult } from "./rootCauseAgent.js";
import { readConfidenceThreshold } from "./confidenceThresholds.js";

// STORY-004 / REQ-010: "gather additional diagnostics when confidence is below 80%."
// Deliberately a separate file from rootCauseAgent.ts (already 200 lines; a second
// Claude-calling capability with its own prompt/schema belongs in its own module,
// not bolted onto R1's).
//
// This does NOT expand what evidence is available (no new DMV types) — that's
// STORY-006's territory ("Enable SQL Server data access"), explicitly out of scope
// here. Instead, when rootCauseAgent's single-answer confidence is too low to act
// on, this asks Claude for a *differential* — several distinct possible causes
// consistent with the same evidence, so a human has options to investigate rather
// than one under-confident guess.
//
// 80 (REQ-010's own threshold) is intentionally separate from rootCauseAgent.ts's
// internal 30 ("insufficient evidence, no usable answer at all") — different
// concepts, both stay as they are.
//
// Deliberate, logged duplication: MissingApiKeyError / defaultCallModel here largely
// mirror rootCauseAgent.ts's. This repo's own composition rule extracts shared logic
// at 3+ occurrences ("two is sometimes a coincidence") — refactoring rootCauseAgent.ts
// to share this now would mean editing a file outside this story to make this one
// pass, which the brief calls out as a stop-and-ask trigger. If a third Claude-calling
// module shows up (e.g. architecture.md's Impact & Remediation or Summary agents),
// that's the right point to extract a shared client helper.

export interface DiagnosticItem {
  description: string;
  possibleCause: string;
}

export interface DiagnosticsResult {
  gathered: boolean; // false when confidence was already >= the threshold — nothing fetched, nothing to present
  diagnostics: DiagnosticItem[];
}

export interface GatherOptions {
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
      `Claude's response did not match the expected diagnostics schema: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = "MalformedResponseError";
    this.cause = cause;
  }
}

const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 4_000;
const MODEL = "claude-sonnet-5";

// REQ-010's own threshold — confidence at or above this needs no further diagnostics.
// REQ-014: configurable via CONFIDENCE_THRESHOLD_GATHER — see confidenceThresholds.ts.
const GATHER_THRESHOLD = readConfidenceThreshold("CONFIDENCE_THRESHOLD_GATHER", 80);

const diagnosticsCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
});

const DiagnosticsResponseSchema = z.object({
  diagnostics: z
    .array(
      z.object({
        description: z.string().min(1),
        possibleCause: z.string().min(1),
      })
    )
    .min(1),
});

function buildPrompt(incident: Incident, rootCause: RootCauseResult): string {
  return [
    `Incident: ${incident.description}`,
    ``,
    `Evidence (cite specific values from these where relevant):`,
    ...incident.evidence.map((e) => `- [${e.id}] (${e.source}): ${JSON.stringify(e.data)}`),
    ``,
    `A first analysis produced this root cause with only ${rootCause.confidence}% confidence:`,
    `"${rootCause.rootCause}"`,
    ``,
    `That confidence is too low to act on a single explanation. List multiple distinct`,
    `possible causes consistent with the evidence above, so a human can investigate`,
    `further rather than act on one under-confident guess.`,
    ``,
    `Respond with a JSON object matching exactly:`,
    `{"diagnostics": [{"description": string, "possibleCause": string}, ...]}`,
    `Provide at least 2 distinct possible causes if the evidence genuinely supports more`,
    `than one plausible explanation. Respond with JSON only, no other text.`,
  ].join("\n");
}

function parseResponse(text: string): z.infer<typeof DiagnosticsResponseSchema> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new MalformedResponseError(error);
  }
  const parsed = DiagnosticsResponseSchema.safeParse(json);
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

// Throws MissingApiKeyError (checked before any attempt, never retried),
// UpstreamTimeoutError / UpstreamCallFailedError / CircuitOpenError (from
// withReliability — covers "diagnostics not gathered"), or MalformedResponseError
// (covers "incorrect diagnostics presented"). Every call logs exactly one event,
// whether or not anything was actually gathered — covers "Trust: all diagnostics
// gathering is logged" as a property of every invocation, not just successful ones.
export async function gatherAdditionalDiagnostics(
  incident: Incident,
  rootCause: RootCauseResult,
  options: GatherOptions = {}
): Promise<DiagnosticsResult> {
  if (rootCause.confidence >= GATHER_THRESHOLD) {
    logEvent({
      level: "info",
      event: "additional_diagnostics_not_needed",
      context: { incidentId: incident.id, confidence: rootCause.confidence },
    });
    return { gathered: false, diagnostics: [] };
  }

  const callModel = options.callModel;
  if (!callModel && !process.env.ANTHROPIC_API_KEY) {
    throw new MissingApiKeyError();
  }
  const modelFn = callModel ?? defaultCallModel;

  const text = await withReliability(() => modelFn(buildPrompt(incident, rootCause)), {
    timeoutMs: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    baseDelayMs: BASE_DELAY_MS,
    maxDelayMs: MAX_DELAY_MS,
    circuitBreaker: diagnosticsCircuitBreaker,
  });

  const parsed = parseResponse(text);

  logEvent({
    level: "info",
    event: "additional_diagnostics_gathered",
    context: {
      incidentId: incident.id,
      rootCauseConfidence: rootCause.confidence,
      diagnosticsCount: parsed.diagnostics.length,
    },
  });

  return { gathered: true, diagnostics: parsed.diagnostics };
}
