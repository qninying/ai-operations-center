// Demo asset, not a test. Run with:
//   npx tsx guardrails/demoGovernanceEngine.ts
//
// Shows the governance engine (ABAC policy + evaluator + HITL queue + audit log)
// working end to end, and — the point of this file — composed with STORY-001's
// existing checkRemediationGuardrail rather than replacing it: ABAC decides whether
// this actor may even request execution; the remediation guardrail then still applies
// as the deeper, content-level check (evidence/approval/action-type) once execution
// is actually attempted. Same split as demoUnsafeAction.ts's own point about R4.

import { evaluateAbacPolicy } from "./abacEvaluator.js";
import { AuditLog, buildPolicyEvaluationAuditEntry } from "./auditLog.js";
import { HitlQueue } from "./hitlQueue.js";
import { checkRemediationGuardrail } from "./remediationGuardrail.js";

function logResult(label: string, result: unknown) {
  console.log(`\n${label}`);
  console.log(JSON.stringify(result, null, 2));
}

const auditLog = new AuditLog();
const queue = new HitlQueue(auditLog, { decisionWindowMs: 600_000 });
let entryCounter = 0;
const nextId = () => `demo-${++entryCounter}`;

console.log("=".repeat(70));
console.log("1. Low-risk view — ABAC allows it directly, no human in the loop");
console.log("=".repeat(70));
const viewRequest = { role: "engineer" as const, resourceType: "incident_detail" as const, action: "view" as const };
const viewDecision = evaluateAbacPolicy(viewRequest);
auditLog.record(buildPolicyEvaluationAuditEntry(viewRequest, viewDecision, "engineer", nextId(), "corr-1"));
logResult("Engineer views INC-4471 technical detail:", viewDecision);

console.log("\n" + "=".repeat(70));
console.log("2. High-risk execution — ABAC requires approval, HITL queue handles it,");
console.log("   THEN the existing remediation guardrail still gates the content");
console.log("=".repeat(70));
const execRequest = { role: "orchestrator" as const, resourceType: "live_execution" as const, action: "request_execution" as const };
const execDecision = evaluateAbacPolicy(execRequest);
auditLog.record(buildPolicyEvaluationAuditEntry(execRequest, execDecision, "orchestrator", nextId(), "corr-2"));
logResult("AI Orchestrator requests execution of the drafted remediation for INC-4471:", execDecision);

const item = queue.enqueue({
  request: { incident: "INC-4471", remediation: "restart-ssis-job-loadcustomerdim" },
  correlationId: "corr-2",
  contextPackage: "Root cause: LoadCustomerDim job deadlocked. Confidence: 91%.",
  primaryApprover: "alex (on-call)",
  backupApprover: "jordan (eng manager)",
});
console.log(`\nEnqueued to HITL: ${item.itemId}, notified ${item.primaryApprover}`);

const decided = queue.decide(item.itemId, "approve", "alex (on-call)", true);
console.log(`alex (on-call) approved item ${item.itemId}`);

const postApprovalRequest = {
  role: "execution_service" as const,
  resourceType: "live_execution" as const,
  action: "execute" as const,
  context: { actorType: "system" as const, approved: true },
};
const postApprovalDecision = evaluateAbacPolicy(postApprovalRequest);
auditLog.record(buildPolicyEvaluationAuditEntry(postApprovalRequest, postApprovalDecision, "execution_service", nextId(), "corr-2"));
logResult("ABAC: Execution Service may now request execution (post-approval):", postApprovalDecision);

const remediationContent = {
  actionType: "restart_service",
  evidenceIds: ["evt-4471"],
  approval: { status: "approved" as const, decidedBy: decided.decidedBy!, decidedAt: new Date().toISOString() },
  targetSystem: { name: "prod-app-server-03", productionWriteProtected: true },
};
const guardrailResult = checkRemediationGuardrail(remediationContent);
logResult("checkRemediationGuardrail (STORY-001's existing content-level gate):", guardrailResult);
console.log("\n-> Both gates agree: this specific remediation is actually allowed to run.");

console.log("\n" + "=".repeat(70));
console.log("3. A human tries to execute directly, bypassing the queue — denied");
console.log("=".repeat(70));
const directExecRequest = {
  role: "approver" as const,
  resourceType: "live_execution" as const,
  action: "execute" as const,
  context: { actorType: "human" as const },
};
const directExecDecision = evaluateAbacPolicy(directExecRequest);
auditLog.record(buildPolicyEvaluationAuditEntry(directExecRequest, directExecDecision, "approver", nextId(), "corr-3"));
logResult("Approver tries to directly execute a fix themselves:", directExecDecision);

console.log("\n" + "=".repeat(70));
console.log(`FULL AUDIT TRAIL (${auditLog.all().length} events)`);
console.log("=".repeat(70));
for (const entry of auditLog.all()) {
  console.log(`[${entry.loggedAt}] ${entry.entryType.padEnd(18)} actor=${entry.actor.padEnd(20)} corr=${entry.correlationId}`);
}
