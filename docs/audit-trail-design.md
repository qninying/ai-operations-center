# Audit Trail Design for AI Systems

## Why this matters

An AI system that can reason about incidents, recommend actions, or — with approval — actually change something in production, makes a lot of small decisions on the way to any single outcome: what it looked at, what it concluded, who reviewed it, what happened next. If any single step in that chain can't be reconstructed after the fact, the system isn't trustworthy no matter how good its decisions usually are. "It probably did the right thing" is not an acceptable answer when someone asks *why* a specific action happened three weeks ago.

An audit trail is the record that makes every decision reconstructable — not a log of what the system *might* have done, but a permanent, ordered account of what it actually did, by whom, and why. Three things make it worth building deliberately rather than bolting on later:

1. **Compliance and accountability.** For anything touching production, finance, or personal data, "we can't tell you what happened" is a real liability, not just an inconvenience.
2. **Debugging and trust-building.** When an AI system's output is wrong, the audit trail is what lets you find out *which step* introduced the error — bad retrieval, a misconfigured policy, a human who approved something they shouldn't have — instead of guessing.
3. **Demonstrating the system deserves the autonomy it has.** A system that can execute real actions after human approval only earns that trust if every approval and every execution is provably linked, in order, with nothing missing.

## Core design principles

An audit trail is only as good as its weakest guarantee. Four properties are non-negotiable:

| Property | What it means | Why it's non-negotiable |
|---|---|---|
| **Append-only** | Entries are added, never edited or deleted | An editable log isn't evidence of anything — it's just a claim |
| **Immutable once written** | A stored entry can't be changed by any later code path, not just by policy | Prevents both accidental mutation and a compromised component quietly rewriting history |
| **Retrievable by ID** | Any single entry can be pulled up directly, not just found by scrolling | Debugging and audits both start from "show me exactly what happened for X," not a full log dump |
| **Attributed** | Every entry names an actor — a person, or a specific system component, never blank | An anonymous decision is not an auditable one |

A fifth property, idempotency, matters specifically because real systems retry things: if the same write is attempted twice (a retried request, a resubmitted approval), recording it twice must not silently duplicate the trail. The correct behavior is to recognize the repeat and treat it as a no-op — covered below.

## The correlation ID: the key to reconstruction

A single user-facing decision is rarely one event — it's a chain: a request comes in, gets evaluated against policy, maybe gets queued for human approval, gets decided, and finally executes. Each of those is a separate audit entry, written by a different piece of code, possibly minutes apart. Without something tying them together, reconstructing "what actually happened for this one incident" means manually correlating timestamps and guessing.

**A correlation ID solves this by being generated once, at the start of a request, and threaded through every subsequent step that touches it** — every log line, every audit entry, every downstream call. Anything that happens as a consequence of the original request carries the same ID.

This means reconstruction becomes a single, mechanical operation: filter the entire audit trail down to one correlation ID, and read the results in timestamp order. No guessing which entries belong together — the ID says so directly.

### What "generated once, threaded through" looks like in practice

1. A correlation ID is minted at the entry point of the request — the first moment the system starts working on something (an incoming event, a user action, a scheduled job firing).
2. It's passed as an explicit parameter into every function that will write an audit entry for this request — not inferred, not looked up, passed directly, so there's no code path where it can silently go missing.
3. Every audit entry — whether it's a policy decision, a human approval, an escalation, or a final execution outcome — carries this same ID as a required field, not an optional one.
4. The audit store exposes retrieval *by* correlation ID as a first-class operation, not something reconstructed by filtering a full dump after the fact.

## A concrete example

This is exactly how CoreOps's own audit log (`guardrails/auditLog.ts`) already works, and it's worth walking through as a real reference rather than a hypothetical:

- Every `AuditEntry` — whether it's a policy evaluation, a human decision, an escalation, or an execution outcome — has a required `correlationId` field, enforced at write time. An entry missing it (or any other required field) is rejected before it's ever stored, not silently accepted with a gap.
- The store exposes `forCorrelationId(id)`, which returns every entry for that ID directly — no manual filtering of a raw log needed.
- Entries are `Object.freeze()`-d once stored, so nothing — not even a bug elsewhere in the codebase — can mutate a record after the fact.
- Each entry is keyed by its own `id`, checked before every write: recording the identical entry twice (say, from a retried call) is treated as a safe no-op, while recording the same ID with *different* content throws an explicit conflict error rather than silently overwriting history. This is the idempotency guarantee mentioned above, made concrete.

**Walking one real incident through it:** an AI Orchestrator requests execution of a remediation for `INC-4471`. That single incident produces a chain of audit entries — a policy evaluation (`orchestrator` requests, decision: `require_approval`), a HITL enqueue event, a human's approval decision, a second policy evaluation (the Execution Service is now allowed to act, post-approval) — all sharing one correlation ID. Anyone who later asks "what actually happened with INC-4471's fix" gets the complete, ordered answer from `forCorrelationId("corr-INC-4471")` alone: no cross-referencing timestamps across separate systems, no guessing whether two log lines are related.

## Implementing this effectively: a checklist

1. **Define your entry schema before writing any code.** Every entry type needs, at minimum: a unique ID, a correlation ID, an actor, a timestamp, and an outcome. Optional fields can vary by entry type; these five cannot be optional on any of them.
2. **Reject invalid entries at write time**, not later. A validation check that runs at write time catches a missing actor or correlation ID immediately, when it's cheap to fix — not months later when someone tries to reconstruct an incident and finds a gap.
3. **Make the store enforce immutability structurally**, not just by convention. If the code technically *can* mutate a stored entry, eventually something will, even by accident. Freeze it, or use storage that physically can't be edited in place.
4. **Treat the same-ID-different-content case as an error, not a silent overwrite.** A conflict here almost always means a real bug (two different events accidentally sharing an ID) — surfacing it loudly is far better than quietly keeping whichever write happened to land last.
5. **Expose retrieval by correlation ID as a first-class query**, not something every consumer has to reimplement by filtering a full dump.
6. **Propagate the correlation ID explicitly through every function signature that touches the request** — resist the temptation to make it implicit (a global, a thread-local) purely for convenience; implicit propagation is exactly the kind of thing that silently breaks the first time someone refactors the code without realizing the ID needs to survive the change.
7. **Log the failures too, not just the successes.** A rejected decision, a denied access attempt, an escalation that timed out — these belong in the same trail, under the same correlation ID, as the actions that succeeded. An audit trail that only records what worked isn't a complete account of what happened.

## Closing point

An audit trail earns its usefulness in exactly the moment nobody wants to need it — when something went wrong and someone needs the real, ordered, unforgeable answer to "what actually happened here." Building it around a correlation ID from day one is what turns that moment from a forensic investigation into a single, direct query.
