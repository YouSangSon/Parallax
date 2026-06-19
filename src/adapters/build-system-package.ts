import path from 'node:path';

import type { Confidence, RelationKind, ScannedFile } from '../types.js';
import type {
  AdapterCapability,
  AdapterRun,
  EntityDescriptor,
  ExtractCtx,
  IndexEvent,
  PendingEvidence,
  SemanticAdapter
} from './types.js';
import { cargoLocalManifestPath, cargoLockfileManifestPath, cargoManifestDir, discoverCargoDependencyContext, discoverCargoLockfiles, parseCargoToml } from './build-system/cargo.js';
import type { ParsedCargoLockfile } from './build-system/cargo.js';
import {
  discoverGradleVersionCatalogs,
  gradleSyntaxDiagnostics,
  gradleVersionCatalogForBuild,
  parseGradleBuild
} from './build-system/gradle.js';
import { discoverGoLocalReplacementIndex, goModSyntaxDiagnostics, goWorkUseTargets, parseGoMod } from './build-system/go.js';
import { mavenSyntaxDiagnostics, parseMavenPom } from './build-system/maven.js';
import {
  discoverNpmLockfiles,
  npmLockfileManifestPath,
  parseNpmPackageJson
} from './build-system/npm.js';
import type { ParsedNpmLockfile } from './build-system/npm.js';
import { discoverPoetryLockfiles, parsePyprojectToml, poetryLockfileManifestPath } from './build-system/python.js';
import type { ParsedPoetryLockfile } from './build-system/python.js';
import {
  buildManifestKind,
  escapeRegExp,
  evidenceForNeedle,
  evidenceLineAt,
  packageKey,
  tomlSectionBlock,
  tomlStringArrayAssignments,
  tomlSyntaxDiagnostics
} from './build-system/shared.js';
import type {
  BuildManifestKind,
  CargoDependencyContext,
  GradleVersionCatalogEntry,
  LocalPackage,
  LocalPackageDiscovery,
  PackageDependency,
  PackageIndex,
  ParsedManifest,
  ScopedPackageDependencyOverrides,
  ScopedPackageIndex
} from './build-system/types.js';

export const BUILD_SYSTEM_PACKAGE_ADAPTER_ID = 'build-system-package-resolver-v0';
export const BUILD_SYSTEM_PACKAGE_ADAPTER_VERSION = '2';

const buildSystemCapabilities: readonly AdapterCapability[] = ['packages', 'references'];

export class BuildSystemPackageAdapter implements SemanticAdapter {
  readonly id = BUILD_SYSTEM_PACKAGE_ADAPTER_ID;
  readonly version = BUILD_SYSTEM_PACKAGE_ADAPTER_VERSION;
  readonly capabilities = buildSystemCapabilities;
  readonly confidence = 'heuristic';
  readonly knownGaps = [
    'npm package-lock, Cargo.lock, and poetry.lock transitive dependencies are indexed; other lockfile ecosystems and semver range impact are not fully resolved',
    'build scripts are not executed, so generated dependency graph edges may be absent'
  ];

  supports(file: ScannedFile): boolean {
    return buildManifestKind(file.relativePath) !== undefined;
  }

  start(ctx: ExtractCtx, files: readonly ScannedFile[]): AdapterRun {
    const gradleCatalogs = discoverGradleVersionCatalogs(files);
    const npmLockfiles = discoverNpmLockfiles(files);
    const cargoLockfiles = discoverCargoLockfiles(files);
    const poetryLockfiles = discoverPoetryLockfiles(files);
    const packageDiscovery = discoverLocalPackages(files, gradleCatalogs);
    const goReplacementIndex = discoverGoLocalReplacementIndex(files, packageDiscovery.byManifest);
    const cargoDependencyContext = discoverCargoDependencyContext(files, packageDiscovery.byManifest);
    const filePathSet = new Set(ctx.indexedFiles.map((file) => file.relativePath));
    return {
      async *process(file: ScannedFile): AsyncIterable<IndexEvent> {
        yield* extractBuildSystemEvents(
          file,
          packageDiscovery.byAlias,
          packageDiscovery.byManifest,
          filePathSet,
          npmLockfiles,
          cargoLockfiles,
          poetryLockfiles,
          gradleCatalogs,
          goReplacementIndex,
          cargoDependencyContext
        );
      }
    };
  }
}

async function* extractBuildSystemEvents(
  file: ScannedFile,
  packageIndex: PackageIndex,
  packageByManifest: ReadonlyMap<string, LocalPackage>,
  filePathSet: ReadonlySet<string>,
  npmLockfiles: ReadonlyMap<string, ParsedNpmLockfile>,
  cargoLockfiles: ReadonlyMap<string, ParsedCargoLockfile>,
  poetryLockfiles: ReadonlyMap<string, ParsedPoetryLockfile>,
  gradleCatalogs: readonly GradleVersionCatalogEntry[],
  goReplacementIndex: ScopedPackageIndex,
  cargoDependencyContext: CargoDependencyContext
): AsyncIterable<IndexEvent> {
  const parsed = parseBuildManifest(
    file,
    gradleCatalogs,
    cargoDependencyContext.dependencyOverrides,
    npmLockfiles,
    cargoLockfiles,
    poetryLockfiles
  );
  const fileDescriptor: EntityDescriptor = {
    kind: 'config',
    path: file.relativePath,
    languageId: file.language,
    displayName: file.relativePath
  };
  for (const message of parsed.diagnostics) {
    yield {
      kind: 'diagnostic',
      level: 'warn',
      message,
      file: file.relativePath
    };
  }
  for (const target of manifestTextTargets(file, filePathSet)) {
    yield relationEvent(
      fileDescriptor,
      { kind: 'file', path: target.path },
      'CONFIGURES',
      'heuristic',
      'build manifest path mention',
      target.evidence
    );
  }
  if (buildManifestKind(file.relativePath) === 'npm-lock') {
    const manifestPath = npmLockfileManifestPath(file.relativePath);
    const localPackage = packageByManifest.get(manifestPath);
    if (localPackage) {
      yield relationEvent(
        fileDescriptor,
        localPackageDescriptor(localPackage),
        'CONFIGURES',
        'proven',
        'npm lockfile package graph',
        evidenceForNeedle(file.content, file.relativePath, '"packages"')
      );
    }
  }
  if (!parsed.package) return;

  const packageDescriptor = localPackageDescriptor(parsed.package);
  yield { kind: 'entity', entity: packageDescriptor };
  yield relationEvent(
    fileDescriptor,
    packageDescriptor,
    'DECLARES',
    'proven',
    `${parsed.package.ecosystem} package manifest`,
    packageEvidence(file, parsed.package)
  );
  yield relationEvent(
    packageDescriptor,
    fileDescriptor,
    'DEPENDS_ON',
    'proven',
    `${parsed.package.ecosystem} package manifest identity`,
    packageEvidence(file, parsed.package)
  );

  for (const dependency of parsed.dependencies) {
    const localTarget = localPackageTarget(
      file,
      dependency,
      packageIndex,
      goReplacementIndex,
      cargoDependencyContext.localDependencies
    );
    const target = localTarget
      ? localPackageDescriptor(localTarget)
      : externalPackageDescriptor(dependency);
    if (target.path !== undefined && target.path === parsed.package.manifestPath) continue;
    if (!localTarget) yield { kind: 'entity', entity: target };
    yield relationEvent(
      packageDescriptor,
      target,
      'DEPENDS_ON',
      localTarget ? localPackageDependencyConfidence(dependency.confidence) : dependency.confidence,
      `${dependency.ecosystem} ${dependency.dependencyType}`,
      dependency.evidence
    );
  }
}

function localPackageDependencyConfidence(confidence: Confidence): Confidence {
  return confidence === 'proven' ? 'proven' : 'inferred';
}

function discoverLocalPackages(
  files: readonly ScannedFile[],
  gradleCatalogs: readonly GradleVersionCatalogEntry[]
): LocalPackageDiscovery {
  const byAlias = new Map<string, LocalPackage>();
  const packagesByManifest = new Map<string, LocalPackage>();
  for (const file of files) {
    const parsed = parseBuildManifest(file, gradleCatalogs);
    if (!parsed.package) continue;
    packagesByManifest.set(parsed.package.manifestPath, parsed.package);
    for (const alias of parsed.package.aliases) {
      byAlias.set(packageKey(parsed.package.ecosystem, alias), parsed.package);
    }
  }
  return { byAlias, byManifest: packagesByManifest };
}

function localPackageTarget(
  file: ScannedFile,
  dependency: PackageDependency,
  packageIndex: PackageIndex,
  goReplacementIndex: ScopedPackageIndex,
  cargoLocalDependencyIndex: ScopedPackageIndex
): LocalPackage | undefined {
  const key = packageKey(dependency.ecosystem, dependency.name);
  if (dependency.ecosystem === 'go') {
    return goReplacementIndex.get(file.relativePath)?.get(key) ?? packageIndex.get(key);
  }
  if (dependency.ecosystem === 'cargo') {
    return cargoLocalDependencyIndex.get(file.relativePath)?.get(key) ?? packageIndex.get(key);
  }
  return packageIndex.get(key);
}

function parseBuildManifest(
  file: ScannedFile,
  gradleCatalogs: readonly GradleVersionCatalogEntry[],
  dependencyOverrides: ScopedPackageDependencyOverrides = new Map(),
  npmLockfiles: ReadonlyMap<string, ParsedNpmLockfile> = new Map(),
  cargoLockfiles: ReadonlyMap<string, ParsedCargoLockfile> = new Map(),
  poetryLockfiles: ReadonlyMap<string, ParsedPoetryLockfile> = new Map()
): ParsedManifest {
  const kind = buildManifestKind(file.relativePath);
  const parsed =
    kind === 'npm' ? parseNpmPackageJson(file, npmLockfiles.get(file.relativePath))
    : kind === 'npm-lock' ? { dependencies: [], diagnostics: npmLockfiles.get(npmLockfileManifestPath(file.relativePath))?.diagnostics ?? [] }
    : kind === 'maven' ? parseMavenPom(file)
    : kind === 'gradle' ? parseGradleBuild(file, gradleVersionCatalogForBuild(file.relativePath, gradleCatalogs))
    : kind === 'go' ? parseGoMod(file)
    : kind === 'cargo' ? parseCargoToml(file, dependencyOverrides.get(file.relativePath), cargoLockfiles.get(file.relativePath))
    : kind === 'cargo-lock' ? { dependencies: [], diagnostics: cargoLockfiles.get(cargoLockfileManifestPath(file.relativePath))?.diagnostics ?? [] }
    : kind === 'python' ? parsePyprojectToml(file, poetryLockfiles.get(file.relativePath))
    : kind === 'poetry-lock' ? { dependencies: [], diagnostics: poetryLockfiles.get(poetryLockfileManifestPath(file.relativePath))?.diagnostics ?? [] }
    : { dependencies: [], diagnostics: [] };
  return {
    ...parsed,
    diagnostics: [...manifestSyntaxDiagnostics(file, kind), ...parsed.diagnostics]
  };
}

function manifestSyntaxDiagnostics(file: ScannedFile, kind: BuildManifestKind | undefined): string[] {
  if (kind === 'maven') return mavenSyntaxDiagnostics(file);
  if (kind === 'gradle') return gradleSyntaxDiagnostics(file);
  if (kind === 'go') return goModSyntaxDiagnostics(file);
  if (kind === 'cargo') return tomlSyntaxDiagnostics(file, 'Cargo.toml');
  if (kind === 'python') return tomlSyntaxDiagnostics(file, 'pyproject.toml');
  return [];
}

function localPackageDescriptor(pkg: LocalPackage): EntityDescriptor {
  return {
    kind: 'package',
    path: pkg.manifestPath,
    languageId: pkg.ecosystem,
    displayName: pkg.displayName,
    metadata: {
      ecosystem: pkg.ecosystem,
      packageName: pkg.name,
      manifestPath: pkg.manifestPath,
      ...(pkg.version ? { version: pkg.version } : {})
    }
  };
}

function externalPackageDescriptor(dependency: PackageDependency): EntityDescriptor {
  return {
    kind: 'package',
    languageId: dependency.ecosystem,
    displayName: dependency.displayName,
    metadata: {
      ecosystem: dependency.ecosystem,
      packageName: dependency.name,
      dependencyType: dependency.dependencyType,
      ...(dependency.version ? { version: dependency.version } : {})
    }
  };
}

function relationEvent(
  source: EntityDescriptor,
  target: EntityDescriptor,
  kind: RelationKind,
  confidence: Confidence,
  provenance: string,
  evidence: PendingEvidence
): IndexEvent {
  return {
    kind: 'relation',
    relation: {
      source,
      target,
      kind,
      metadata: { confidence, provenance },
      evidence: [evidence]
    }
  };
}

function packageEvidence(file: ScannedFile, pkg: LocalPackage): PendingEvidence {
  return evidenceForNeedle(file.content, file.relativePath, pkg.name);
}

function manifestTextTargets(
  file: ScannedFile,
  filePathSet: ReadonlySet<string>
): Array<{ path: string; evidence: PendingEvidence }> {
  const targets: Array<{ path: string; evidence: PendingEvidence }> = [];
  const seen = new Set<string>();
  if (buildManifestKind(file.relativePath) === 'go-work') {
    for (const target of goWorkUseTargets(file, filePathSet)) {
      if (seen.has(target.path)) continue;
      seen.add(target.path);
      targets.push(target);
    }
  }
  if (buildManifestKind(file.relativePath) === 'cargo') {
    for (const target of cargoWorkspaceMemberTargets(file, filePathSet)) {
      if (seen.has(target.path)) continue;
      seen.add(target.path);
      targets.push(target);
    }
  }
  for (const target of inferManifestTextTargets(file, filePathSet)) {
    if (seen.has(target.path)) continue;
    seen.add(target.path);
    targets.push(target);
  }
  return targets;
}

function inferManifestTextTargets(
  file: ScannedFile,
  filePathSet: ReadonlySet<string>
): Array<{ path: string; evidence: PendingEvidence }> {
  const targets: Array<{ path: string; evidence: PendingEvidence }> = [];
  const seen = new Set<string>();
  const lowerContent = file.content.toLowerCase();
  for (const candidatePath of [...filePathSet].sort((left, right) => right.length - left.length || left.localeCompare(right))) {
    if (candidatePath === file.relativePath) continue;
    const offset = pathMentionOffset(lowerContent, candidatePath);
    if (offset < 0 || seen.has(candidatePath)) continue;
    seen.add(candidatePath);
    targets.push({
      path: candidatePath,
      evidence: evidenceLineAt(file.content, file.relativePath, offset)
    });
  }
  return targets;
}

function cargoWorkspaceMemberTargets(
  file: ScannedFile,
  filePathSet: ReadonlySet<string>
): Array<{ path: string; evidence: PendingEvidence }> {
  const workspace = tomlSectionBlock(file.content, 'workspace');
  if (!workspace) return [];
  const members = tomlStringArrayAssignments(workspace).find((assignment) => assignment.key === 'members');
  if (!members) return [];
  return members.values.flatMap((member) =>
    cargoWorkspaceMemberManifestPaths(file.relativePath, member.value, filePathSet).map((memberPath) => ({
      path: memberPath,
      evidence: evidenceLineAt(file.content, file.relativePath, member.offset)
    }))
  );
}

function cargoWorkspaceMemberManifestPaths(
  relativePath: string,
  memberPattern: string,
  filePathSet: ReadonlySet<string>
): string[] {
  if (!hasGlobToken(memberPattern)) {
    const memberManifestPath = cargoLocalManifestPath(relativePath, memberPattern);
    return memberManifestPath && filePathSet.has(memberManifestPath) ? [memberManifestPath] : [];
  }
  const rootDir = cargoManifestDir(relativePath);
  const normalizedPattern = path.posix.normalize(path.posix.join(rootDir, memberPattern, 'Cargo.toml'));
  if (normalizedPattern === '..' || normalizedPattern.startsWith('../') || path.posix.isAbsolute(normalizedPattern)) return [];
  const regex = globPatternRegex(normalizedPattern);
  return [...filePathSet]
    .filter((candidatePath) => regex.test(candidatePath))
    .sort();
}

function hasGlobToken(value: string): boolean {
  return /[*?]/.test(value);
}

function globPatternRegex(pattern: string): RegExp {
  const escaped = escapeRegExp(pattern)
    .replace(/\\\*/g, '[^/]*')
    .replace(/\\\?/g, '[^/]');
  return new RegExp(`^${escaped}$`);
}

function pathMentionOffset(lowerContent: string, relativePath: string): number {
  const exactOffset = boundedIndexOf(lowerContent, relativePath.toLowerCase());
  if (exactOffset >= 0) return exactOffset;
  return boundedIndexOf(lowerContent, `./${relativePath.toLowerCase()}`);
}

function boundedIndexOf(lowerContent: string, lowerNeedle: string): number {
  let offset = lowerContent.indexOf(lowerNeedle);
  while (offset >= 0) {
    if (hasPathTokenBoundary(lowerContent, offset, offset + lowerNeedle.length)) return offset;
    offset = lowerContent.indexOf(lowerNeedle, offset + 1);
  }
  return -1;
}

function hasPathTokenBoundary(content: string, start: number, end: number): boolean {
  const before = start > 0 ? content[start - 1] : undefined;
  const after = end < content.length ? content[end] : undefined;
  return !isPathTokenChar(before) && !isPathTokenChar(after);
}

function isPathTokenChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_./-]/.test(char);
}
