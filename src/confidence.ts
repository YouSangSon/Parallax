import type { Confidence } from './types.js';

// Coerce an arbitrary string (e.g. a database column) to a valid Confidence,
// falling back to 'unknown' for any value outside the known set.
export function asConfidence(value: string): Confidence {
  if (value === 'proven' || value === 'inferred' || value === 'heuristic' || value === 'unknown') {
    return value;
  }
  return 'unknown';
}
