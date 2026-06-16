import type { ScannedFile } from '../types.js';
import type { AdapterManifestEntry, AdapterSelectionMode, SemanticAdapter } from './types.js';

const defaultSelectionMode: AdapterSelectionMode = 'targeted';

function selectionModeFor(adapter: Pick<SemanticAdapter, 'selectionMode'>): AdapterSelectionMode {
  return adapter.selectionMode ?? defaultSelectionMode;
}

function manifestEntryFor(adapter: SemanticAdapter, order: number): AdapterManifestEntry {
  const entry: AdapterManifestEntry = {
    order,
    id: adapter.id,
    version: adapter.version,
    capabilities: Object.freeze([...adapter.capabilities]),
    confidence: adapter.confidence ?? 'unknown',
    knownGaps: Object.freeze([...(adapter.knownGaps ?? [])]),
    selectionMode: selectionModeFor(adapter)
  };
  return Object.freeze(entry);
}

export class AdapterRegistry {
  private readonly adapters: SemanticAdapter[] = [];

  register(adapter: SemanticAdapter): void {
    if (this.adapters.some((existing) => existing.id === adapter.id)) {
      throw new Error(`adapter already registered: ${adapter.id}`);
    }
    const catchAllAdapter = this.adapters.find((existing) => selectionModeFor(existing) === 'catch-all');
    if (catchAllAdapter) {
      throw new Error(
        `cannot register adapter ${adapter.id} after catch-all adapter ${catchAllAdapter.id}; ` +
          'catch-all adapters must be registered last'
      );
    }
    this.adapters.push(adapter);
  }

  // First-match-wins in registration order. Adapters marked catch-all are
  // terminal by contract, and register() enforces that they stay last.
  pickAdapter(file: ScannedFile): SemanticAdapter | undefined {
    for (const adapter of this.adapters) {
      if (adapter.supports(file)) {
        return adapter;
      }
    }
    return undefined;
  }

  classify(files: readonly ScannedFile[]): Map<SemanticAdapter, ScannedFile[]> {
    const grouped = new Map<SemanticAdapter, ScannedFile[]>();
    for (const file of files) {
      const adapter = this.pickAdapter(file);
      if (!adapter) {
        continue;
      }
      let bucket = grouped.get(adapter);
      if (!bucket) {
        bucket = [];
        grouped.set(adapter, bucket);
      }
      bucket.push(file);
    }
    return grouped;
  }

  list(): readonly SemanticAdapter[] {
    return Object.freeze([...this.adapters]);
  }

  manifest(): readonly AdapterManifestEntry[] {
    return Object.freeze(this.adapters.map((adapter, order) => manifestEntryFor(adapter, order)));
  }
}
