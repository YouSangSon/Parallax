import { createHash } from 'node:crypto';

export interface EmbeddingResult {
  model: string;
  vector: Buffer;
  dim: number;
}

export const STUB_MODEL_NAME = 'stub-sha256';
const DEFAULT_REAL_MODEL = 'Xenova/multilingual-e5-base';
const STUB_DIM = 768;

interface FeatureExtractionPipeline {
  (
    text: string | string[],
    options: { pooling: 'mean' | 'cls' | 'none'; normalize: boolean }
  ): Promise<{ data: Float32Array | Int8Array | Uint8Array; dims: number[] }>;
}

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
let cachedModelName: string | null = null;

function selectedModel(): string {
  return process.env.IMPACT_TRACE_EMBEDDING_MODEL ?? DEFAULT_REAL_MODEL;
}

export function selectedEmbeddingModel(): string {
  return selectedModel();
}

async function getOrCreatePipeline(modelId: string): Promise<FeatureExtractionPipeline> {
  if (!pipelinePromise || cachedModelName !== modelId) {
    cachedModelName = modelId;
    pipelinePromise = (async () => {
      const transformers = await import('@huggingface/transformers');
      const pipe = await transformers.pipeline('feature-extraction', modelId, {
        dtype: 'q8'
      });
      return pipe as unknown as FeatureExtractionPipeline;
    })();
  }
  return pipelinePromise;
}

function quantizeToInt8(values: Float32Array): Buffer {
  const int8 = new Int8Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const v = Math.max(-1, Math.min(1, values[i] ?? 0));
    int8[i] = Math.round(v * 127);
  }
  return Buffer.from(int8.buffer, int8.byteOffset, int8.byteLength);
}

/**
 * Async embedding via @huggingface/transformers (ONNX in-process).
 *
 * Default model: Xenova/multilingual-e5-base (~278 MB, 768-dim,
 * multilingual including Korean). Override via env:
 *   IMPACT_TRACE_EMBEDDING_MODEL=stub-sha256       # deterministic stub
 *   IMPACT_TRACE_EMBEDDING_MODEL=Xenova/bge-base-en-v1.5
 *   IMPACT_TRACE_EMBEDDING_MODEL=Xenova/all-mpnet-base-v2
 *
 * The first call lazy-downloads the model into the user's HF cache.
 * Subsequent calls are warm (~50–150ms on M-series CPU).
 *
 * Returns L2-normalized int8 vectors so that dot product on the bytes
 * (after dividing by 127) approximates cosine similarity.
 */
export async function computeEmbedding(text: string): Promise<EmbeddingResult> {
  const model = selectedModel();
  if (model === STUB_MODEL_NAME) {
    return computeEmbeddingSync(text);
  }
  const pipe = await getOrCreatePipeline(model);
  const prefixed = model.toLowerCase().includes('e5') ? `passage: ${text}` : text;
  const output = await pipe(prefixed, { pooling: 'mean', normalize: true });
  const float32 = output.data instanceof Float32Array
    ? output.data
    : new Float32Array(Array.from(output.data, (v) => Number(v)));
  return {
    model,
    vector: quantizeToInt8(float32),
    dim: float32.length
  };
}

/**
 * Sync stub: deterministic hash-based pseudo-vector (no semantic meaning).
 * Used by tests and by `computeEmbedding` when the model is set to
 * the sentinel `stub-sha256`. Identical text yields identical vectors.
 */
export function computeEmbeddingSync(text: string): EmbeddingResult {
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
