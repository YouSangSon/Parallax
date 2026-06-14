import type { Confidence } from '../../types.js';
import type { PendingEvidence } from '../types.js';

export type PackageEcosystem = 'npm' | 'maven' | 'gradle' | 'go' | 'cargo' | 'python';

export type LocalPackage = {
  ecosystem: PackageEcosystem;
  name: string;
  manifestPath: string;
  displayName: string;
  version?: string;
  aliases: readonly string[];
};

export type PackageDependency = {
  ecosystem: PackageEcosystem;
  name: string;
  displayName: string;
  version?: string | undefined;
  dependencyType: string;
  confidence: Confidence;
  evidence: PendingEvidence;
};

export type ParsedManifest = {
  package?: LocalPackage;
  dependencies: PackageDependency[];
  diagnostics: string[];
};

export type PackageIndex = ReadonlyMap<string, LocalPackage>;
export type LocalPackageDiscovery = {
  byAlias: PackageIndex;
  byManifest: ReadonlyMap<string, LocalPackage>;
};
export type ScopedPackageIndex = ReadonlyMap<string, PackageIndex>;
export type PackageDependencyOverride = {
  version?: string;
  path?: string;
};
export type ScopedPackageDependencyOverrides = ReadonlyMap<string, ReadonlyMap<string, PackageDependencyOverride>>;
export type BuildManifestKind = PackageEcosystem | 'gradle-settings' | 'gradle-version-catalog' | 'go-work' | 'pnpm-workspace';

export type GradleCatalogLibrary = {
  name: string;
  displayName: string;
  version?: string;
};

export type GradleVersionCatalog = {
  libraries: ReadonlyMap<string, GradleCatalogLibrary>;
  bundles: ReadonlyMap<string, readonly string[]>;
};

export type GradleVersionCatalogEntry = {
  rootDir: string;
  catalog: GradleVersionCatalog;
};

export type TomlSectionBlock = {
  name: string;
  text: string;
  start: number;
};

export type TomlStringValue = {
  value: string;
  offset: number;
};

export type TomlStringArrayAssignment = {
  key: string;
  values: readonly TomlStringValue[];
};

export type CargoDependencyContext = {
  localDependencies: ScopedPackageIndex;
  dependencyOverrides: ScopedPackageDependencyOverrides;
};

export type CargoDependencyEntry = {
  name: string;
  dependencyType: string;
  version?: string;
  path?: string;
  workspaceInherited: boolean;
  offset: number;
};

export type CargoWorkspaceDefinition = {
  rootManifestPath: string;
  rootDir: string;
  dependencies: ReadonlyMap<string, CargoWorkspaceDependency>;
};

export type CargoWorkspaceDependency = {
  name: string;
  version?: string;
  path?: string;
};
