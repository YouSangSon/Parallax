import path from 'node:path';

import type { ScannedFile } from '../../types.js';
import {
  buildManifestKind,
  dedupeDependencies,
  evidenceLineAt,
  localPackage,
  packageKey,
  stripTomlComment,
  tomlInlineString,
  tomlInlineStringField,
  tomlSectionBlock,
  tomlSections,
  tomlStringInSection
} from './shared.js';
import type {
  CargoDependencyContext,
  CargoDependencyEntry,
  CargoWorkspaceDefinition,
  CargoWorkspaceDependency,
  LocalPackage,
  PackageDependency,
  PackageDependencyOverride,
  PackageIndex,
  ParsedManifest,
  TomlSectionBlock
} from './types.js';

export function discoverCargoDependencyContext(
  files: readonly ScannedFile[],
  packagesByManifest: ReadonlyMap<string, LocalPackage>
): CargoDependencyContext {
  const localDependenciesByManifest = new Map<string, PackageIndex>();
  const overridesByManifest = new Map<string, Map<string, PackageDependencyOverride>>();
  const workspaceDefinitions = discoverCargoWorkspaceDefinitions(files);
  for (const file of files) {
    if (buildManifestKind(file.relativePath) !== 'cargo') continue;
    const localDependencies = new Map<string, LocalPackage>();
    const dependencyOverrides = new Map<string, PackageDependencyOverride>();
    const workspace = cargoWorkspaceForManifest(file.relativePath, workspaceDefinitions);
    for (const dependency of cargoDependencyEntries(file)) {
      const workspaceDependency = dependency.workspaceInherited
        ? workspace?.dependencies.get(dependency.name)
        : undefined;
      const dependencyPath = dependency.path ?? workspaceDependency?.path;
      const dependencyVersion = dependency.version ?? workspaceDependency?.version;
      const key = packageKey('cargo', dependency.name);
      if (dependencyVersion || dependencyPath) {
        dependencyOverrides.set(key, {
          ...(dependencyVersion ? { version: dependencyVersion } : {}),
          ...(dependencyPath ? { path: dependencyPath } : {})
        });
      }
      const dependencyPathBase = dependency.path ? file.relativePath : workspace?.rootManifestPath;
      const targetManifestPath = dependencyPath && dependencyPathBase
        ? cargoLocalManifestPath(dependencyPathBase, dependencyPath)
        : undefined;
      const localTarget = targetManifestPath ? packagesByManifest.get(targetManifestPath) : undefined;
      if (localTarget) localDependencies.set(key, localTarget);
    }
    if (localDependencies.size > 0) localDependenciesByManifest.set(file.relativePath, localDependencies);
    if (dependencyOverrides.size > 0) overridesByManifest.set(file.relativePath, dependencyOverrides);
  }
  return {
    localDependencies: localDependenciesByManifest,
    dependencyOverrides: overridesByManifest
  };
}

function discoverCargoWorkspaceDefinitions(files: readonly ScannedFile[]): CargoWorkspaceDefinition[] {
  return files
    .filter((file) => buildManifestKind(file.relativePath) === 'cargo' && tomlSectionBlock(file.content, 'workspace'))
    .map((file) => ({
      rootManifestPath: file.relativePath,
      rootDir: cargoManifestDir(file.relativePath),
      dependencies: cargoWorkspaceDependencies(file)
    }))
    .sort((left, right) => right.rootDir.length - left.rootDir.length || left.rootManifestPath.localeCompare(right.rootManifestPath));
}

function cargoWorkspaceForManifest(
  relativePath: string,
  workspaces: readonly CargoWorkspaceDefinition[]
): CargoWorkspaceDefinition | undefined {
  return workspaces.find((workspace) => (
    relativePath === workspace.rootManifestPath ||
    workspace.rootDir.length === 0 ||
    relativePath.startsWith(`${workspace.rootDir}/`)
  ));
}

function cargoWorkspaceDependencies(file: ScannedFile): Map<string, CargoWorkspaceDependency> {
  const dependencies = new Map<string, CargoWorkspaceDependency>();
  const section = tomlSectionBlock(file.content, 'workspace.dependencies');
  if (!section) return dependencies;
  for (const dependency of cargoDependencyEntriesInSection(section)) {
    dependencies.set(dependency.name, {
      name: dependency.name,
      ...(dependency.version ? { version: dependency.version } : {}),
      ...(dependency.path ? { path: dependency.path } : {})
    });
  }
  return dependencies;
}

export function parseCargoToml(
  file: ScannedFile,
  dependencyOverrides: ReadonlyMap<string, PackageDependencyOverride> | undefined
): ParsedManifest {
  const packageName = tomlStringInSection(file.content, 'package', 'name');
  if (!packageName) {
    return tomlSectionBlock(file.content, 'workspace')
      ? { dependencies: [], diagnostics: [] }
      : { dependencies: [], diagnostics: [`Cargo.toml missing [package].name: ${file.relativePath}`] };
  }
  const pkg = localPackage('cargo', packageName, file.relativePath, packageName, tomlStringInSection(file.content, 'package', 'version'), [packageName]);
  const dependencies = cargoDependencyEntries(file).map((dependency) => cargoDependency(file, dependency, dependencyOverrides));
  return { package: pkg, dependencies: dedupeDependencies(dependencies), diagnostics: [] };
}

function cargoDependency(
  file: ScannedFile,
  dependency: CargoDependencyEntry,
  dependencyOverrides: ReadonlyMap<string, PackageDependencyOverride> | undefined
): PackageDependency {
  const override = dependencyOverrides?.get(packageKey('cargo', dependency.name));
  const dependencyPath = dependency.path ?? override?.path;
  return {
    ecosystem: 'cargo',
    name: dependency.name,
    displayName: dependency.name,
    version: dependency.version ?? override?.version,
    dependencyType: dependency.dependencyType,
    confidence: dependencyPath ? 'proven' : 'heuristic',
    evidence: evidenceLineAt(file.content, file.relativePath, dependency.offset)
  };
}

function cargoDependencyEntries(file: ScannedFile): CargoDependencyEntry[] {
  return tomlSections(file.content)
    .filter((section) => cargoDependencyType(section.name) !== undefined)
    .flatMap((section) => cargoDependencyEntriesInSection(section));
}

function cargoDependencyEntriesInSection(section: TomlSectionBlock): CargoDependencyEntry[] {
  const dependencyType = cargoDependencyType(section.name) ?? section.name;
  const dependencies: CargoDependencyEntry[] = [];
  let lineOffset = 0;
  for (const line of section.text.split(/\r?\n/)) {
    const uncommented = stripTomlComment(line);
    const dottedWorkspace = /^[ \t]*([A-Za-z0-9_-]+)\.workspace[ \t]*=[ \t]*true\b/.exec(uncommented);
    if (dottedWorkspace) {
      dependencies.push({
        name: dottedWorkspace[1]!,
        dependencyType,
        workspaceInherited: true,
        offset: section.start + lineOffset + line.indexOf(dottedWorkspace[1]!)
      });
      lineOffset += line.length + 1;
      continue;
    }
    const dependencyMatch = /^[ \t]*([A-Za-z0-9_-]+)[ \t]*=[ \t]*(.+)$/.exec(uncommented);
    if (dependencyMatch) {
      const value = dependencyMatch[2]!.trim();
      const version = tomlInlineString(value) ?? tomlInlineStringField(value, 'version');
      const dependencyPath = tomlInlineStringField(value, 'path');
      dependencies.push({
        name: dependencyMatch[1]!,
        dependencyType,
        workspaceInherited: cargoDependencyUsesWorkspace(value),
        offset: section.start + lineOffset + line.indexOf(dependencyMatch[1]!),
        ...(version ? { version } : {}),
        ...(dependencyPath ? { path: dependencyPath } : {})
      });
    }
    lineOffset += line.length + 1;
  }
  return dependencies;
}

function cargoDependencyType(sectionName: string): string | undefined {
  if (/^(?:dependencies|dev-dependencies|build-dependencies)$/.test(sectionName)) return sectionName;
  if (/^target\..+\.(?:dependencies|dev-dependencies|build-dependencies)$/.test(sectionName)) return sectionName;
  return undefined;
}

function cargoDependencyUsesWorkspace(value: string): boolean {
  return /(?:^|[,{ \t])workspace[ \t]*=[ \t]*true\b/.test(value);
}

export function cargoLocalManifestPath(relativePath: string, crateDir: string): string | undefined {
  if (path.posix.isAbsolute(crateDir)) return undefined;
  const manifestPath = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), crateDir, 'Cargo.toml'));
  if (manifestPath === '..' || manifestPath.startsWith('../') || path.posix.isAbsolute(manifestPath)) return undefined;
  return manifestPath;
}

export function cargoManifestDir(relativePath: string): string {
  const dir = path.posix.dirname(relativePath);
  return dir === '.' ? '' : dir;
}
