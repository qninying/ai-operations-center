// Semantic (embedding-similarity) layer of the triage_active_incidents dedup
// cache, ADR-015. triageDedupCache.ts's exact-key cache only catches a
// second call whose evidence is byte-for-byte the same; this module catches
// the more common real case -- the same underlying incident observed a few
// seconds later with one extra blocked session, or a slightly different
// wait time -- by comparing embeddings of the evidence text instead of the
// text itself.
//
// A second, real benefit beyond catching more duplicates: unlike
// triageJudgmentCache (an in-memory Map, explicitly documented in
// mcpServerFactory.ts as per-process and NOT shared across replicas), this
// cache lives in Postgres. A second replica behind a load balancer sees the
// same rows a first replica just wrote.
//
// Pooled connection + withReliability + CircuitBreaker: the exact same
// resilience pattern pgBackendStatusSource.ts already uses for its own
// Postgres calls, reused here rather than reinvented.

import pg from "pg";
import { withReliability } from "./reliability/withReliability.js";
import { CircuitBreaker } from "./reliability/circuitBreaker.js";

// Short and unforgiving on purpose: this is a best-effort optimization layer
// sitting in front of a real, much slower sampling call. If the vector DB
// can't answer in 3s, the honest answer is "treat it as unavailable and
// sample fresh" -- a single retry (not this repo's usual 3, see
// pgBackendStatusSource.ts) for the same reason: a caller waiting on a
// human-facing triage result shouldn't absorb multiple retry rounds for an
// optimization that has a perfectly good fallback (skip it).
const TIMEOUT_MS = 3_000;
const MAX_RETRIES = 1;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 500;

// A separate breaker instance from pgActivitySource.ts's/
// pgBackendStatusSource.ts's own -- those talk to a simulated remediation
// TARGET (ADR-013); this talks to this app's own internal vector store.
// Unrelated failure domains, must never trip or be blocked by each other.
const semanticCacheCircuitBreaker = new CircuitBreaker({
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
});

export interface SemanticCacheConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface SemanticMatch {
  judgmentText: string;
  evidenceText: string;
  computedAt: number;
  distance: number;
}

export interface SemanticCacheEntry {
  cacheKey: string;
  embedding: number[];
  judgmentText: string;
  evidenceText: string;
  computedAt: number;
}

// pgvector cosine distance (the <=> operator): 0 = identical direction, 1 =
// orthogonal, 2 = opposite. 0.08 (roughly 92% cosine similarity) is a
// reasoned starting point, not yet tuned against a labeled dataset of real
// near-duplicate vs. genuinely-different incidents (see ADR-015's Notes) --
// deliberately conservative, because a false match here means showing a
// human a judgment that was actually reasoned about DIFFERENT evidence than
// what they asked about. In a governance-first tool, a missed cache hit
// (falls through to a real, correct re-sample) is a far cheaper mistake
// than a wrong cache hit (shows a plausible-looking but ungrounded answer).
export const TRIAGE_SEMANTIC_SIMILARITY_THRESHOLD = 0.08;

// Rows older than this are deleted opportunistically on every store() call.
// Deliberately much longer than the TTL a match query actually honors
// (callers pass TRIAGE_CACHE_TTL_MS from triageDedupCache.ts, 15 minutes) --
// this bounds table growth, it is not a correctness mechanism; the WHERE
// clause in runFindSemanticMatch is what actually makes a match "fresh."
export const TRIAGE_SEMANTIC_RETENTION_MS = 24 * 60 * 60 * 1000;

// Lazily created on first real call, not at module load -- this module is
// only ever imported by mcpServerFactory.ts behind a `PG_VECTOR_HOST is set`
// check, so a bare `import` of this file (e.g. from a test) never opens a
// socket. One pool per process, reused across every call, matching
// pgBackendStatusSource.ts's own pool lifecycle.
let pool: pg.Pool | null = null;

function getPool(config: SemanticCacheConfig): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: 5,
    });
  }
  return pool;
}

// pgvector's text input format for a vector literal is a plain
// "[v1,v2,...]" string bound as a normal query parameter -- no special pg
// type registration needed for this, since we only ever write full vectors
// wholesale and read the <=> distance back as a plain float.
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

async function runFindSemanticMatch(
  config: SemanticCacheConfig,
  embedding: number[],
  ttlMs: number,
  now: number
): Promise<SemanticMatch | null> {
  const client = await getPool(config).connect();
  try {
    const cutoff = new Date(now - ttlMs).toISOString();
    // LIMIT 1 always returns the single closest row regardless of how far
    // away it actually is -- the threshold check happens in JS below, not
    // in this query, so "a row came back" and "it's similar enough" stay
    // two separate, separately-testable questions.
    const result = await client.query(
      `SELECT judgment_text, evidence_text, computed_at, embedding <=> $1 AS distance
       FROM triage_judgments
       WHERE computed_at > $2
       ORDER BY embedding <=> $1
       LIMIT 1`,
      [toVectorLiteral(embedding), cutoff]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    const distance = Number(row.distance);
    if (distance > TRIAGE_SEMANTIC_SIMILARITY_THRESHOLD) return null;
    return {
      judgmentText: row.judgment_text,
      evidenceText: row.evidence_text,
      computedAt: new Date(row.computed_at).getTime(),
      distance,
    };
  } finally {
    client.release();
  }
}

export async function findSemanticMatch(
  config: SemanticCacheConfig,
  embedding: number[],
  ttlMs: number,
  now: number = Date.now()
): Promise<SemanticMatch | null> {
  return withReliability(() => runFindSemanticMatch(config, embedding, ttlMs, now), {
    timeoutMs: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    baseDelayMs: BASE_DELAY_MS,
    maxDelayMs: MAX_DELAY_MS,
    circuitBreaker: semanticCacheCircuitBreaker,
  });
}

async function runStoreSemanticEntry(config: SemanticCacheConfig, entry: SemanticCacheEntry): Promise<void> {
  const client = await getPool(config).connect();
  try {
    await client.query(
      `INSERT INTO triage_judgments (cache_key, evidence_text, judgment_text, embedding, computed_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        entry.cacheKey,
        entry.evidenceText,
        entry.judgmentText,
        toVectorLiteral(entry.embedding),
        new Date(entry.computedAt).toISOString(),
      ]
    );
    // Opportunistic retention cleanup, same call -- see
    // TRIAGE_SEMANTIC_RETENTION_MS's own comment. Best-effort: if this
    // DELETE fails after the INSERT above already succeeded, the row is
    // still stored correctly, the table just grows slightly past its bound
    // until the next successful store() call retries the cleanup.
    await client.query(`DELETE FROM triage_judgments WHERE computed_at < $1`, [
      new Date(entry.computedAt - TRIAGE_SEMANTIC_RETENTION_MS).toISOString(),
    ]);
  } finally {
    client.release();
  }
}

export async function storeSemanticEntry(config: SemanticCacheConfig, entry: SemanticCacheEntry): Promise<void> {
  return withReliability(() => runStoreSemanticEntry(config, entry), {
    timeoutMs: TIMEOUT_MS,
    maxRetries: MAX_RETRIES,
    baseDelayMs: BASE_DELAY_MS,
    maxDelayMs: MAX_DELAY_MS,
    circuitBreaker: semanticCacheCircuitBreaker,
  });
}
