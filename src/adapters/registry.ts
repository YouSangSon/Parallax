import type { ScannedFile } from '../types.js';
import type { SemanticAdapter } from './types.js';

export class AdapterRegistry {
  private readonly adapters: SemanticAdapter[] = [];

  register(adapter: SemanticAdapter): void {
    if (this.adapters.some((existing) => existing.id === adapter.id)) {
      throw new Error(`adapter already registered: ${adapter.id}`);
    }
    this.adapters.push(adapter);
  }

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
    return this.adapters;
  }
}
