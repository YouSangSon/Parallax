import type { Confidence, EntityKind, RelationKind, ScannedFile } from '../types.js';

// EntityDescriptor → orchestrator content-hashes this to compute entity ID.
export interface EntityDescriptor {
  readonly kind: EntityKind;
  readonly path?: string;
  readonly symbol?: string;
  readonly symbolKind?: string;
  readonly languageId?: string;
  readonly displayName?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PendingEntity extends EntityDescriptor {}

export interface PendingEvidence {
  readonly file: string;
  readonly snippet?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly startCol?: number;
  readonly endCol?: number;
  readonly confidence: Confidence;
}

export interface PendingRelation {
  readonly source: EntityDescriptor;
  readonly target: EntityDescriptor;
  readonly kind: RelationKind;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly evidence?: readonly PendingEvidence[];
}

export type AdapterCapability =
  | 'imports'
  | 'exports'
  | 'calls'
  | 'references'
  | 'types'
  | 'symbols'
  | 'docrefs'
  | 'tests'
  | 'packages';

export type AdapterSelectionMode = 'targeted' | 'catch-all';

export interface AdapterManifestEntry {
  readonly order: number;
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly AdapterCapability[];
  readonly confidence: Confidence;
  readonly knownGaps: readonly string[];
  readonly selectionMode: AdapterSelectionMode;
}

export type IndexEvent =
  | { readonly kind: 'entity'; readonly entity: PendingEntity }
  | { readonly kind: 'relation'; readonly relation: PendingRelation }
  | {
      readonly kind: 'diagnostic';
      readonly level: 'warn' | 'error';
      readonly message: string;
      readonly file?: string;
    };

export interface ExtractCtx {
  readonly repoRoot: string;
  readonly indexRunId: number;
  readonly adapterRunId: number;
  readonly indexedFiles: readonly Readonly<ScannedFile>[];
}

// AdapterRun: returned once per index run by adapter.start(); process() yields events per file.
export interface AdapterRun {
  process(file: ScannedFile): AsyncIterable<IndexEvent>;
  dispose?(): Promise<void> | void;
}

export interface SemanticAdapter {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly AdapterCapability[];
  readonly confidence?: Confidence;
  readonly knownGaps?: readonly string[];
  readonly selectionMode?: AdapterSelectionMode;
  supports(file: ScannedFile): boolean;
  start(ctx: ExtractCtx, files: readonly ScannedFile[]): Promise<AdapterRun> | AdapterRun;
}
