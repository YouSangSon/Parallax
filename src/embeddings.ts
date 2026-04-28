import { createHash } from 'node:crypto';

export interface EmbeddingResult {
  model: string;
  vector: Buffer;
  dim: number;
}

export const STUB_MODEL_NAME = 'stub-sha256';
const STUB_DIM = 768;

/**
 * Phase 1 stub: deterministic hash-based pseudo-embedding for pipeline testing.
 * Identical text yields identical vectors; different text yields different
 * vectors; there is NO semantic similarity.
 *
 * Replace with a real model (Ollama / OpenAI / Cohere / Voyage / Transformers.js)
 * in a Phase 2 follow-up. The signature stays the same so callers do not need
 * to change. The `model` field tags every row in fact_embeddings so multiple
 * models can coexist during a swap.
 */
export function computeEmbedding(text: string): EmbeddingResult {
  const seed = createHash('sha256').update(text).digest();
  const bytes = new Int8Array(STUB_DIM);
  let chain = seed;
  let cursor = 0;
  while (cursor < STUB_DIM) {
    chain = createHash('sha256').update(chain).digest();
    for (let i = 0; i < chain.length && cursor < STUB_DIM; i += 1) {
      bytes[cursor] = chain[i]! - 128;
      cursor += 1;
    }
  }
  return {
    model: STUB_MODEL_NAME,
    vector: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    dim: STUB_DIM
  };
}
