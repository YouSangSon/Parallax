import { createHash } from 'node:crypto';

export interface EmbeddingResult {
  dim64Binary: Buffer;
  dim768Int8: Buffer;
}

const DIM64_BYTES = 8;
const DIM768_BYTES = 768;

/**
 * Phase 1 stub: deterministic hash-based pseudo-embedding for pipeline testing.
 * Identical text yields identical vectors; different text yields different
 * vectors; there is NO semantic similarity.
 *
 * Replace with a real model (Ollama / OpenAI / Cohere / Voyage) in a Phase 2
 * follow-up. The signature stays the same so callers do not need to change.
 *
 * Output is two tiers, matching the embeddings table schema in store.ts:
 *  - dim64Binary: 8 bytes (first 8 of SHA-256). Intended for ANN pre-filter via popcount.
 *  - dim768Int8:  768 signed int8 bytes (range -128..127). Intended for refinement.
 */
export function computeEmbedding(text: string): EmbeddingResult {
  const seed = createHash('sha256').update(text).digest();

  const dim64Binary = Buffer.from(seed.subarray(0, DIM64_BYTES));

  const bytes = new Int8Array(DIM768_BYTES);
  let chain = seed;
  let cursor = 0;
  while (cursor < DIM768_BYTES) {
    chain = createHash('sha256').update(chain).digest();
    for (let i = 0; i < chain.length && cursor < DIM768_BYTES; i += 1) {
      bytes[cursor] = chain[i]! - 128;
      cursor += 1;
    }
  }
  return {
    dim64Binary,
    dim768Int8: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  };
}
