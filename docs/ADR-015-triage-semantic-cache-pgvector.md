# ADR-015: Semantic Dedup for `triage_active_incidents` via pgvector

**Status:** Implemented — built, unit-tested, and verified against a real Postgres+pgvector container.
**Owner:** Quincy Nkwain Ninying
**Date:** 2026-09-14
**Component:** `mcp-server/src/triageSemanticCache.ts`, `mcp-server/src/embeddingModel.ts`, `mcp-server/src/mcpServerFactory.ts`

---

## Context

The AI Employee Charter governance gap closed on 2026-09-13 (`triageDedupCache.ts`) dedups `triage_active_incidents` on an *exact* content-addressed key: two calls only share a cached judgment if the underlying evidence rows are byte-for-byte identical once sorted. That module's own header comment names the real limitation directly: a new blocked session or one cleared one produces a different key, so the far more common real case — the same underlying incident observed a few seconds later with a slightly different wait time, or one extra row — still triggers a fresh, unnecessary sampling call.

Separately: `mcpServerFactory.ts`'s exact-key cache is explicitly documented as module-level and per-process, "not shared across replicas behind a load balancer" — a second pod re-samples evidence a first pod already judged, an accepted limitation at the time because "closing the dedup gap doesn't require adding a new external dependency."

This ADR is a deliberate decision to now accept that dependency, for two compounding reasons: it closes the semantic-duplicate gap the exact-key cache can't, and — as a side effect of choosing a shared external store — it also closes the multi-replica gap the exact-key cache explicitly punted on.

## Decision drivers

| Driver | Source | Why it matters here |
|---|---|---|
| Catch near-duplicates, not just exact ones | The real-world pattern this repo's own triage tool sees: same incident, evidence drifts slightly between calls | An exact-key cache's miss rate on genuinely-the-same incidents is the actual gap being closed |
| Correctness over hit rate | This repo's trust/governance posture (INPACT scorecard, evidence-grounding-check ADR-008) | A false semantic match shows a human a judgment reasoned about DIFFERENT evidence than what they asked about — worse than a miss |
| No paid external service | CLAUDE.md's escalation list explicitly names "paid external services"; this repo has avoided them so far | Local embeddings (no API key, no per-call cost) over OpenAI/Voyage |
| Zero new dependencies is not free here | ADR-005 chose JSONL specifically to avoid a first-ever DB dependency | Unlike the audit trail, this feature has no correctness requirement forcing durability — the infra cost is being taken on deliberately, for the semantic-matching capability itself, not because the feature strictly needs a database |
| User's explicit call | This repo's DRI weighed the ADR-005-style "reuse what exists, add nothing" option against real pgvector and chose real pgvector | Documented here rather than defaulted into, per CLAUDE.md's "database engine introduction" being a Strategic Decision |

## Options considered

| | **A: In-process cosine similarity (no new infra)** | **B: pgvector (chosen)** | **C: Reuse an existing Postgres container** |
|---|---|---|---|
| New infrastructure | None | A new, dedicated Postgres+pgvector container | None |
| Multi-replica sharing | No — same per-process limitation as the exact-key cache | Yes | Yes, but see below |
| Matches this repo's own precedent | Yes — mirrors ADR-005's "zero new moving parts unless the tradeoff earns it" | No — this repo has avoided app-owned databases until now | Partially |
| Scale fit | Fine at this cache's actual size (a TTL-pruned, low-volume incident cache) | Overkill at current scale, real at production scale | N/A |
| Rejected because | User explicitly wanted the pgvector implementation for its own sake, not just the feature | — | `dev-postgres/`'s own container is a simulated remediation TARGET (ADR-013) — its own header comment already rules out sharing it across purposes, for the same "one action could silently break the other's demo" reason that applies here too |

Option A is the ADR-005-consistent default and remains the right call if this ever needs to ship without the infra cost. It was not chosen here because closing the multi-replica gap and building a real, resume-defensible pgvector integration were both explicit goals of this change, not just the dedup improvement itself.

## Decision

**A new, dedicated `pgvector/pgvector:pg16` container** (`mcp-server/dev-vector-db/docker-compose.yml`, port 5435) holds one table, `triage_judgments`, with an `HNSW` index over `vector_cosine_ops`. Entirely optional at runtime: `PG_VECTOR_HOST` unset means the feature never activates — no model load, no connection attempt, same "missing config → honest fallback" convention every other optional integration in `.env.example` already uses (`SQLSERVER_HOST`, `AZURE_STORAGE_CONNECTION_STRING`).

**Embeddings are local, not a paid API.** `mcp-server/src/embeddingModel.ts` wraps `@huggingface/transformers` running `Xenova/all-MiniLM-L6-v2` (384 dimensions) in-process via ONNX Runtime. No API key, no per-call cost, no new external-call failure mode added to an ops tool whose entire job is diagnosing failures.

**Flow, added to the existing `triage_active_incidents` handler in `mcpServerFactory.ts`:**
1. Exact-key cache check (unchanged, `triageDedupCache.ts`).
2. Client sampling-capability check (unchanged).
3. **New:** if `PG_VECTOR_HOST` is configured, embed the current evidence text and query `triage_judgments` for the closest row within the same 15-minute TTL the exact cache uses (`TRIAGE_CACHE_TTL_MS`, imported, not duplicated). A row closer than `TRIAGE_SEMANTIC_SIMILARITY_THRESHOLD` (cosine distance 0.08 — see Notes) counts as a match.
4. On a semantic hit, the response shows **both** evidence blocks — what the cached judgment was actually reasoned about, and what was just asked about — explicitly inviting the human to judge equivalence themselves, rather than presenting a merged or single evidence block as if they were the same thing.
5. On a genuine miss, sampling proceeds exactly as before; on success, the new judgment is stored both in the existing in-memory exact cache and as a new row in `triage_judgments` (embedding included), with an opportunistic 24-hour retention cleanup on the same write.

**Reliability:** both the lookup and the store call go through `withReliability` + a dedicated `CircuitBreaker` — the same resilience pattern `pgBackendStatusSource.ts` already uses for its own Postgres calls, reused rather than reinvented. Timeout is a deliberately short 3s with only 1 retry (not this repo's usual 3): this is a best-effort layer in front of a real, working fallback (sample fresh), so a caller waiting on a human-facing triage result should not absorb multiple retry rounds for an optional optimization. **Any failure — model load, connection, timeout, circuit open — is logged (`mcp_triage_semantic_unavailable` / `mcp_triage_semantic_store_failed`, with a real `errorClass`) and swallowed, never rethrown.** The tool degrades to exact-match-only behavior, indistinguishable from before this ADR, for as long as the vector DB is unreachable.

## Failure-First Design (required questions, CLAUDE.md)

1. **What happens if this fails?** The semantic layer is skipped for that call; the tool falls through to the exact-key cache result or a fresh sampling call, exactly as it behaved before this ADR existed.
2. **Retry strategy?** One retry, 250ms base backoff, 3s timeout per attempt (`withReliability`). Deliberately shorter/fewer than this repo's typical 3-retry Postgres calls — see Reliability above.
3. **Recovery path if retries are exhausted?** None needed beyond the fallback itself — an operator notices via repeated `mcp_triage_semantic_unavailable` warnings in the logs if the vector DB is down for the long haul, and can restart `dev-vector-db`'s container. No dead-letter queue: nothing is queued, a skipped semantic lookup has no state to recover.
4. **Failure modes handled vs. not:** Handled — connection refused, query timeout, model load failure, circuit open. Not handled — a running vector DB whose schema has silently drifted from `init.sql` (would surface as a generic SQL error, caught by the same generic catch, same degraded outcome, just not specifically diagnosed as "schema drift" in the log).

## Known, accepted risk: transitive CVEs in `@huggingface/transformers`

`npm audit` after adding this dependency reports 4 unresolved high-severity findings, all transitive and all without an upstream fix available yet at this package's current release:

| Package | Path | Why accepted |
|---|---|---|
| `sharp` | image-decoding support for vision models | Not reachable — this integration only ever calls `pipeline("feature-extraction", ...)` with plain evidence strings this process built itself; image loading code is never invoked |
| `adm-zip` | `onnxruntime-node`'s own install-time native-binary unpacking | Install-time only, unpacking `onnxruntime-node`'s own vetted npm-published tarball, not attacker-controlled input, not part of this server's runtime request path |
| `onnxruntime-node` | flagged via its `adm-zip` dependency | Same as above |
| `@huggingface/transformers` | flagged via the above two | Same |

`hono`, `qs`, `vitest`/`@vitest/mocker`, and `fast-uri` — the other findings `npm audit` initially reported — **were fixed** via `npm audit fix` (non-breaking patch bumps); only the four above remain, because no fixed release of `@huggingface/transformers`'s pinned `onnxruntime-node`/`sharp` versions exists yet. Revisit this table the next time `@huggingface/transformers` ships a release, and re-run `npm audit` before then if this feature's usage pattern ever changes to touch image input.

## Consequences

- Closes both the semantic-duplicate gap and the multi-replica cache-sharing gap the 2026-09-13 exact-key cache left open, in one change.
- First app-owned database dependency in this repo, and the first dependency with unresolved (if unreachable) transitive high-severity CVEs — both logged here rather than silently absorbed, per this repo's own governance rules.
- `mcp-server/dev-vector-db/` needs `docker compose up -d` before `PG_VECTOR_HOST` is set for local dev; unset (the default), the feature is fully inert and every existing test and code path behaves exactly as before this ADR.
