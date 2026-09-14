-- ADR-015: schema for the triage_active_incidents semantic dedup cache.
-- Runs automatically on first container start via
-- docker-entrypoint-initdb.d/ -- re-running it against an already-initialized
-- volume is a no-op (Postgres only executes init scripts once, on an empty
-- data directory), so this file does not need its own idempotency guards
-- beyond IF NOT EXISTS.

CREATE EXTENSION IF NOT EXISTS vector;

-- 384 dimensions: the output width of the Xenova/all-MiniLM-L6-v2 embedding
-- model (mcp-server/src/embeddingModel.ts). Changing the embedding model
-- means changing this column's dimension and re-embedding every row --
-- there is no migration path for a dimension change, only a rebuild.
CREATE TABLE IF NOT EXISTS triage_judgments (
  id BIGSERIAL PRIMARY KEY,
  cache_key TEXT NOT NULL,
  evidence_text TEXT NOT NULL,
  judgment_text TEXT NOT NULL,
  embedding VECTOR(384) NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL
);

-- Every query filters on computed_at (the TTL window) before ranking by
-- distance, so a plain btree index on computed_at keeps that filter cheap
-- even as the table grows past what the TTL window itself would match.
CREATE INDEX IF NOT EXISTS triage_judgments_computed_at_idx ON triage_judgments (computed_at);

-- HNSW over cosine distance: all-MiniLM embeddings are L2-normalized
-- (embedText() passes normalize: true), so cosine distance and Euclidean
-- distance rank identically here -- cosine is used because it's the
-- conventional choice for sentence embeddings and makes the distance value
-- itself interpretable (0 = identical, 2 = opposite) independent of vector
-- magnitude.
CREATE INDEX IF NOT EXISTS triage_judgments_embedding_idx ON triage_judgments
  USING hnsw (embedding vector_cosine_ops);
