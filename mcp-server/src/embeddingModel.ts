// Local, free, offline sentence embeddings for the triage semantic cache
// (ADR-015) -- no API key, no per-call cost, no external network dependency
// once the model weights are cached locally. Chosen over a paid embeddings
// API (OpenAI, Voyage) specifically because the rest of this repo has
// deliberately avoided paid external services for internal-ops-tool
// plumbing (see ADR-005's "zero new dependencies unless the tradeoff
// genuinely earns it"), and this one substitutes a one-time model download
// for a recurring per-call cost and a new external-call failure mode.
//
// @huggingface/transformers runs the model via ONNX Runtime in-process; the
// first call in a given environment downloads and caches the ~90MB model
// weights, which is why this module is never imported unless
// PG_VECTOR_HOST is actually set (see mcpServerFactory.ts) -- the default
// dev/test experience never triggers a model download at all.
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

// Must match the VECTOR(384) column in dev-vector-db/init.sql.
export const EMBEDDING_DIMENSIONS = 384;

// Loaded once per process and reused -- constructing the pipeline is the
// expensive part (model load), running it per call is cheap. Deliberately
// not wrapped in the same testable-module pattern as triageSemanticCache.ts:
// this function has no branching logic of its own to unit test, it's a thin
// wrapper around a third-party model load, same boundary mcpServerFactory.ts
// itself sits at (see that file's own header comment on why it has no test
// file).
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", MODEL_ID);
  }
  return extractorPromise;
}

// mean pooling collapses the model's per-token vectors into one
// sentence-level vector; normalize: true L2-normalizes it so cosine
// distance in triageSemanticCache.ts is well-behaved (see init.sql's own
// comment on why cosine ops were chosen).
export async function embedText(text: string): Promise<number[]> {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}
