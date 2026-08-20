// Pure ABAC evaluator middleware. Same purity contract as checkRemediationGuardrail:
// deterministic, no I/O, safe to call on every request. Rule matching is first-match-
// wins in file order (like firewall rules) -- more specific denial rules must be
// listed before broader allow rules they'd otherwise be shadowed by. No match ->
// policy.defaultEffect ("deny"), so an unanticipated attribute combination fails
// closed, not open.

import { ABAC_POLICY, AbacPolicy, AbacRequest, Effect, PolicyContext, RiskLevel } from "./abacPolicy.js";

export interface AbacDecision {
  decision: Effect;
  riskLevel: RiskLevel | "unknown";
  matchedRuleId: string | null;
  reason: string;
}

function contextMatches(when: PolicyContext | undefined, actual: PolicyContext | undefined): boolean {
  if (!when) return true;
  const actualContext = actual ?? {};
  return Object.entries(when).every(([key, expected]) => actualContext[key] === expected);
}

export function evaluateAbacPolicy(request: AbacRequest, policy: AbacPolicy = ABAC_POLICY): AbacDecision {
  for (const rule of policy.rules) {
    const { when } = rule;
    if (when.role && when.role !== request.role) continue;
    if (when.resourceType && when.resourceType !== request.resourceType) continue;
    if (when.action && when.action !== request.action) continue;
    if (!contextMatches(when.context, request.context)) continue;

    return {
      decision: rule.effect,
      riskLevel: rule.riskLevel,
      matchedRuleId: rule.id,
      reason: rule.description,
    };
  }

  return {
    decision: policy.defaultEffect,
    riskLevel: "unknown",
    matchedRuleId: null,
    reason: "No rule matched this request; failing closed to the policy's default effect.",
  };
}
