// Pure classifier for incremental indexing (S1). Given the prior completed run's
// per-file content hashes + extractor version and the current working tree's, it
// decides whether the next run can reuse unchanged files' graph rows, and which
// files must be re-extracted.
//
// It is deliberately conservative. Cross-file edges are file-level and resolved
// against target *paths* (verified empirically), so an unchanged file's edges are
// byte-identical only while the path set and the extractor are stable. Any change
// to either — a different extractor_version, or any added/deleted/renamed file —
// could shift resolution for files whose content did not change, so the delta
// falls back to a full reindex. This keeps the incremental path provably
// byte-identical to a full reindex for the common case (editing existing files).

export type IndexDeltaMode = 'full' | 'incremental';

export type IndexRunFiles = {
  extractorVersion: string;
  // path -> content hash for every indexed file in the run.
  files: ReadonlyMap<string, string>;
};

export type IndexDeltaInput = {
  prior: IndexRunFiles | null;
  current: IndexRunFiles;
};

export type IndexDelta = {
  mode: IndexDeltaMode;
  // Why a full reindex was chosen ('' when incremental).
  reason: string;
  // Unchanged files whose prior rows can be carried forward (incremental only).
  unchanged: string[];
  // Files whose content changed and must be re-extracted (incremental only).
  changed: string[];
  // Files present now but not in the prior run (informational).
  added: string[];
  // Files present in the prior run but gone now (informational).
  deleted: string[];
};

function fullReindex(reason: string, added: string[] = [], deleted: string[] = []): IndexDelta {
  return { mode: 'full', reason, unchanged: [], changed: [], added, deleted };
}

export function computeIndexDelta(input: IndexDeltaInput): IndexDelta {
  const { prior, current } = input;
  if (!prior) {
    return fullReindex('no prior completed index run');
  }

  const priorPaths = new Set(prior.files.keys());
  const added = [...current.files.keys()].filter((path) => !priorPaths.has(path)).sort();
  const deleted = [...priorPaths].filter((path) => !current.files.has(path)).sort();

  if (prior.extractorVersion !== current.extractorVersion) {
    return fullReindex(
      `extractor_version changed (${prior.extractorVersion} -> ${current.extractorVersion})`,
      added,
      deleted
    );
  }

  if (added.length > 0 || deleted.length > 0) {
    return fullReindex('file set changed (add/delete/rename); cross-file resolution may shift', added, deleted);
  }

  const changed: string[] = [];
  const unchanged: string[] = [];
  for (const [path, hash] of current.files) {
    if (prior.files.get(path) === hash) {
      unchanged.push(path);
    } else {
      changed.push(path);
    }
  }
  changed.sort();
  unchanged.sort();

  return { mode: 'incremental', reason: '', unchanged, changed, added: [], deleted: [] };
}
