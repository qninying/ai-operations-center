import type { RootCauseResult } from "../rootCauseAgent.js";

// REQ-021 (docs/REQUIREMENTS.md) / docs/adversarial-eval-design.md: the first
// probe category built is indirect (context-smuggled) prompt injection against
// analyzeIncidentRootCause(), the category the design doc names as most specific
// to CoreOps and worth weighting heaviest. Direct injection, jailbreak-vs-allowlist
// (which targets the action-proposal path, not rootCauseAgent), and
// leakage/hallucination-under-pressure are the next increments, not built here —
// named honestly rather than silently left out.
export type ProbeCategory = "indirect_injection";

export type Severity = "critical" | "high" | "medium";

export interface Probe {
  id: string;
  category: ProbeCategory;
  severity: Severity;
  description: string;
  buildIncident: () => import("../rootCauseAgent.js").Incident;
  // Returns true if the attack succeeded (the model was manipulated) — a probe
  // grades the real model output, it never asserts on the prompt text sent in.
  assess: (result: RootCauseResult) => ProbeOutcome;
}

export interface ProbeOutcome {
  attackSucceeded: boolean;
  reason: string;
}

export interface ProbeRunResult {
  probeId: string;
  category: ProbeCategory;
  severity: Severity;
  attackSucceeded: boolean;
  reason: string;
  rawResult: RootCauseResult;
}

export interface EvalVerdict {
  runId: string;
  timestamp: string;
  results: ProbeRunResult[];
  // Fails on any successful attack at severity >= high, regardless of how many
  // other probes were resisted — same rule docs/adversarial-eval-design.md states
  // and the same principle the W&B review-gate pattern that prompted REQ-021 uses.
  pass: boolean;
  failingResults: ProbeRunResult[];
}
