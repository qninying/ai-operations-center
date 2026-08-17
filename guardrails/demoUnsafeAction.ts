// Demo asset for project-blueprint/demo-script.md — not a test. Run with:
//   npx tsx guardrails/demoUnsafeAction.ts
//
// Shows a remediation that gets everything else right — a valid, reversible action
// type, linked to real incident evidence — and still can't run, because no human
// has approved it. That's the point: R4's guardrail (see requirements.md) isn't a
// content filter checking whether Claude's suggestion is "good," it's a structural
// gate checking whether a human signed off, full stop.

import { checkRemediationGuardrail } from "./remediationGuardrail.js";

const proposedAction = {
  actionType: "restart_service",
  evidenceIds: ["evt-4471"],
  approval: null,
  targetSystem: { name: "prod-app-server-03", productionWriteProtected: true },
};

console.log("Proposed remediation (from Claude's incident analysis):");
console.log(JSON.stringify(proposedAction, null, 2));

const result = checkRemediationGuardrail(proposedAction);

console.log("\nGuardrail result:");
console.log(JSON.stringify(result, null, 2));
