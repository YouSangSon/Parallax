import type { Confidence } from './types.js';

// Coerce an arbitrary string (e.g. a database column) to a valid Confidence,
// falling back to 'unknown' for any value outside the known set.
export function asConfidence(value: string): Confidence {
  if (value === 'proven' || value === 'inferred' || value === 'heuristic' || value === 'unknown') {
    return value;
  }
  return 'unknown';
}

const CONFIDENCE_RANK: Record<Confidence, number> = {
  proven: 3,
  inferred: 2,
  heuristic: 1,
  unknown: 0
};

export function confidenceRank(value: Confidence): number {
  return CONFIDENCE_RANK[value];
}

// Decide whether `analyze` should fail (exit non-zero) given the confidences of
// its affected files. With no gate the historical behavior holds — any affected
// file fails. A confidence-level gate fails only when an affected file meets or
// exceeds that confidence; `any` and `none` are explicit bounds. Powers the
// confidence-aware CI gate: `parallax analyze --fail-on=<level>`.
export function failsImpactGate(
  confidences: readonly Confidence[],
  failOn: string | undefined
): boolean {
  if (failOn === undefined || failOn === 'any') return confidences.length > 0;
  if (failOn === 'none') return false;
  if (failOn !== 'proven' && failOn !== 'inferred' && failOn !== 'heuristic') {
    throw new Error(
      `invalid --fail-on value: ${failOn} (expected proven|inferred|heuristic|any|none)`
    );
  }
  const minimum = confidenceRank(failOn);
  return confidences.some((confidence) => confidenceRank(confidence) >= minimum);
}
