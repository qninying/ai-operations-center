# CoreOps AI Operations Dashboard — Traceability

Every requirement, and the stories that fulfil it. A `must` requirement with no
story is a gap the plan gate refuses to publish; a constraint legitimately has
none, because it is context rather than work.

| Requirement | Kind | Priority | Fulfilled by |
|---|---|---|---|
| REQ-001 | Safety | must | STORY-001 |
| REQ-002 | Functional | must | STORY-003 |
| REQ-003 | Functional | must | STORY-003 |
| REQ-004 | Functional | must | STORY-003 |
| REQ-005 | Safety | must | STORY-002 |
| REQ-006 | Functional | must | STORY-005 |
| REQ-007 | Constraint | must | STORY-006 |
| REQ-008 | Constraint | must | STORY-007 |
| REQ-009 | Functional | must | STORY-005 |
| REQ-010 | Functional | must | STORY-004 |
| REQ-011 | Functional | must | STORY-009 |
| REQ-012 | Safety | must | STORY-010 |
| REQ-013 | Functional | must | STORY-006, STORY-007 |
| REQ-014 | Functional | should | _(fulfilled directly — `mcp-server/src/confidenceThresholds.ts`, no platform story assigned)_ |
| REQ-015 | Safety | must | STORY-011 |
| REQ-016 | Functional | must | STORY-008 |
| REQ-017 | Non-functional | should | _(fulfilled directly — `mcp-server/src/correlatedRecommendationService.ts`, no platform story assigned)_ |
| REQ-018 | Constraint | must | _(constraint — no story)_ |
| REQ-019 | Safety | should | _(fulfilled directly — `mcp-server/src/evidenceGroundingCheck.ts`, no platform story assigned)_ |

✅ Every must-have requirement is fulfilled by at least one story.
