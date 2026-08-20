import { describe, it, expect } from "vitest";
import { evaluateAbacPolicy } from "./abacEvaluator.js";
import { AbacPolicy, AbacRequest } from "./abacPolicy.js";

describe("evaluateAbacPolicy", () => {
  it("allows a matching low-risk request (happy path)", () => {
    const result = evaluateAbacPolicy({
      role: "engineer",
      resourceType: "incident_detail",
      action: "view",
    });
    expect(result).toEqual({
      decision: "allow",
      riskLevel: "low",
      matchedRuleId: "engineer-view-technical-detail",
      reason: "Engineers can view full technical incident detail.",
    });
  });

  it("denies a request an explicit rule denies, even though a broader allow rule for the same resource exists", () => {
    const result = evaluateAbacPolicy({
      role: "executive",
      resourceType: "incident_detail",
      action: "view",
    });
    expect(result.decision).toBe("deny");
    expect(result.matchedRuleId).toBe("executive-cannot-view-technical-detail");
  });

  it("routes a high-risk execution request to require_approval rather than allow or deny", () => {
    const result = evaluateAbacPolicy({
      role: "orchestrator",
      resourceType: "live_execution",
      action: "request_execution",
    });
    expect(result.decision).toBe("require_approval");
    expect(result.riskLevel).toBe("high");
  });

  it("never allows a human to execute directly, regardless of context", () => {
    const result = evaluateAbacPolicy({
      role: "approver",
      resourceType: "live_execution",
      action: "execute",
      context: { actorType: "human" },
    });
    expect(result.decision).toBe("deny");
    expect(result.matchedRuleId).toBe("no-human-executes-directly");
  });

  it("allows the system to execute only when the context marks it approved (boundary)", () => {
    const notYetApproved = evaluateAbacPolicy({
      role: "execution_service",
      resourceType: "live_execution",
      action: "execute",
      context: { actorType: "system", approved: false },
    });
    const approved = evaluateAbacPolicy({
      role: "execution_service",
      resourceType: "live_execution",
      action: "execute",
      context: { actorType: "system", approved: true },
    });

    expect(notYetApproved.decision).toBe("deny"); // falls through to defaultEffect — no rule matches approved:false
    expect(approved.decision).toBe("allow");
    expect(approved.matchedRuleId).toBe("system-executes-after-recorded-approval");
  });

  it("failure path — no rule matches: fails closed to the policy's default effect, not open", () => {
    const result = evaluateAbacPolicy({
      role: "auditor",
      resourceType: "dependency_map",
      action: "edit",
    });
    expect(result.decision).toBe("deny");
    expect(result.matchedRuleId).toBeNull();
  });

  it("is pure: identical input twice yields identical output", () => {
    const request: AbacRequest = { role: "engineer", resourceType: "dependency_map", action: "edit" };
    const first = evaluateAbacPolicy(request);
    const second = evaluateAbacPolicy(request);
    expect(first).toEqual(second);
  });

  it("respects a custom policy passed explicitly, not just the default export", () => {
    const customPolicy: AbacPolicy = {
      version: "test",
      defaultEffect: "deny",
      rules: [
        {
          id: "custom-allow-all-auditors",
          description: "test-only rule",
          when: { role: "auditor" },
          riskLevel: "low",
          effect: "allow",
        },
      ],
    };
    const result = evaluateAbacPolicy(
      { role: "auditor", resourceType: "dependency_map", action: "edit" },
      customPolicy
    );
    expect(result.decision).toBe("allow");
    expect(result.matchedRuleId).toBe("custom-allow-all-auditors");
  });
});
