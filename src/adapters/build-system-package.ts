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

export const BUILD_SYSTEM_PACKAGE_ADAPTER_ID = 'build-system-package-resolver-v0';
export const BUILD_SYSTEM_PACKAGE_ADAPTER_VERSION = '1';

type PackageEcosystem = 'npm' | 'maven' | 'gradle' | 'go' | 'cargo' | 'python';

type LocalPackage = {
  ecosystem: PackageEcosystem;
  name: string;
  manifestPath: string;
  displayName: string;
  version?: string;
  aliases: readonly string[];
};

type PackageDependency = {
  ecosystem: PackageEcosystem;
  name: string;
  displayName: string;
  version?: string | undefined;
  dependencyType: string;
  confidence: Confidence;
  evidence: PendingEvidence;
};

type ParsedManifest = {
  package?: LocalPackage;
  dependencies: PackageDependency[];
  diagnostics: string[];
};

type PackageIndex = ReadonlyMap<string, LocalPackage>;
type LocalPackageDiscovery = {
  byAlias: PackageIndex;
  byManifest: ReadonlyMap<string, LocalPackage>;
};
type ScopedPackageIndex = ReadonlyMap<string, PackageIndex>;
type PackageDependencyOverride = {
  version?: string;
  path?: string;
};
type ScopedPackageDependencyOverrides = ReadonlyMap<string, ReadonlyMap<string, PackageDependencyOverride>>;
type BuildManifestKind = PackageEcosystem | 'gradle-settings' | 'gradle-version-catalog' | 'go-work' | 'pnpm-workspace';

type GradleCatalogLibrary = {
  name: string;
  displayName: string;
  version?: string;
};

type GradleVersionCatalog = {
  libraries: ReadonlyMap<string, GradleCatalogLibrary>;
  bundles: ReadonlyMap<string, readonly string[]>;
};

type GradleVersionCatalogEntry = {
  rootDir: string;
  catalog: GradleVersionCatalog;
};

type TomlSectionBlock = {
  name: string;
  text: string;
  start: number;
};

type TomlStringValue = {
  value: string;
  offset: number;
};

type TomlStringArrayAssignment = {
  key: string;
  values: readonly TomlStringValue[];
};

type CargoDependencyContext = {
  localDependencies: ScopedPackageIndex;
  dependencyOverrides: ScopedPackageDependencyOverrides;
};

type CargoDependencyEntry = {
  name: string;
  dependencyType: string;
  version?: string;
  path?: string;
  workspaceInherited: boolean;
  offset: number;
};

type CargoWorkspaceDefinition = {
  rootManifestPath: string;
  rootDir: string;
  dependencies: ReadonlyMap<string, CargoWorkspaceDependency>;
};

type CargoWorkspaceDependency = {
  name: string;
  version?: string;
  path?: string;
};

const buildSystemCapabilities: readonly AdapterCapability[] = ['packages', 'references'];

export class BuildSystemPackageAdapter implements SemanticAdapter {
  readonly id = BUILD_SYSTEM_PACKAGE_ADAPTER_ID;
  readonly version = BUILD_SYSTEM_PACKAGE_ADAPTER_VERSION;
  readonly capabilities = buildSystemCapabilities;

  supports(file: ScannedFile): boolean {
    return buildManifestKind(file.relativePath) !== undefined;
  }

  start(ctx: ExtractCtx, files: readonly ScannedFile[]): AdapterRun {
    const gradleCatalogs = discoverGradleVersionCatalogs(files);
    const packageDiscovery = discoverLocalPackages(files, gradleCatalogs);
    const goReplacementIndex = discoverGoLocalReplacementIndex(files, packageDiscovery.byManifest);
    const cargoDependencyContext = discoverCargoDependencyContext(files, packageDiscovery.byManifest);
    const filePathSet = new Set(ctx.indexedFiles.map((file) => file.relativePath));
    return {
      async *process(file: ScannedFile): AsyncIterable<IndexEvent> {
        yield* extractBuildSystemEvents(
          file,
          packageDiscovery.byAlias,
          filePathSet,
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
  filePathSet: ReadonlySet<string>,
  gradleCatalogs: readonly GradleVersionCatalogEntry[],
  goReplacementIndex: ScopedPackageIndex,
  cargoDependencyContext: CargoDependencyContext
): AsyncIterable<IndexEvent> {
  const parsed = parseBuildManifest(file, gradleCatalogs, cargoDependencyContext.dependencyOverrides);
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

function discoverGoLocalReplacementIndex(
  files: readonly ScannedFile[],
  packagesByManifest: ReadonlyMap<string, LocalPackage>
): ScopedPackageIndex {
  const replacementsByManifest = new Map<string, PackageIndex>();
  for (const file of files) {
    if (buildManifestKind(file.relativePath) !== 'go') continue;
    const replacements = new Map<string, LocalPackage>();
    for (const replacement of goLocalReplaceAliases(file)) {
      const localTarget = packagesByManifest.get(replacement.targetManifestPath);
      if (localTarget) replacements.set(packageKey('go', replacement.modulePath), localTarget);
    }
    if (replacements.size > 0) replacementsByManifest.set(file.relativePath, replacements);
  }
  return replacementsByManifest;
}

function discoverCargoDependencyContext(
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
  dependencyOverrides: ScopedPackageDependencyOverrides = new Map()
): ParsedManifest {
  const kind = buildManifestKind(file.relativePath);
  const parsed =
    kind === 'npm' ? parseNpmPackageJson(file)
    : kind === 'maven' ? parseMavenPom(file)
    : kind === 'gradle' ? parseGradleBuild(file, gradleVersionCatalogForBuild(file.relativePath, gradleCatalogs))
    : kind === 'go' ? parseGoMod(file)
    : kind === 'cargo' ? parseCargoToml(file, dependencyOverrides.get(file.relativePath))
    : kind === 'python' ? parsePyprojectToml(file)
    : { dependencies: [], diagnostics: [] };
  return {
    ...parsed,
    diagnostics: [...manifestSyntaxDiagnostics(file, kind), ...parsed.diagnostics]
  };
}

function buildManifestKind(relativePath: string): BuildManifestKind | undefined {
  const basename = path.posix.basename(relativePath);
  if (basename === 'package.json') return 'npm';
  if (basename === 'pom.xml') return 'maven';
  if (basename === 'settings.gradle' || basename === 'settings.gradle.kts') return 'gradle-settings';
  if (basename === 'build.gradle' || basename === 'build.gradle.kts') return 'gradle';
  if (basename === 'libs.versions.toml') return 'gradle-version-catalog';
  if (basename === 'go.mod') return 'go';
  if (basename === 'go.work') return 'go-work';
  if (basename === 'Cargo.toml') return 'cargo';
  if (basename === 'pyproject.toml') return 'python';
  if (basename === 'pnpm-workspace.yaml') return 'pnpm-workspace';
  return undefined;
}

function manifestSyntaxDiagnostics(file: ScannedFile, kind: BuildManifestKind | undefined): string[] {
  if (kind === 'maven') return mavenSyntaxDiagnostics(file);
  if (kind === 'gradle') return gradleSyntaxDiagnostics(file);
  if (kind === 'go') return goModSyntaxDiagnostics(file);
  if (kind === 'cargo') return tomlSyntaxDiagnostics(file, 'Cargo.toml');
  if (kind === 'python') return tomlSyntaxDiagnostics(file, 'pyproject.toml');
  return [];
}

function mavenSyntaxDiagnostics(file: ScannedFile): string[] {
  const withoutComments = stripXmlComments(file.content);
  if (/<project\b/i.test(withoutComments) && !/<\/project\s*>/i.test(withoutComments)) {
    return [`pom.xml parse failed: missing </project>: ${file.relativePath}`];
  }
  return [];
}

function gradleSyntaxDiagnostics(file: ScannedFile): string[] {
  const braces = delimiterBalance(file.content, '{', '}');
  const parentheses = delimiterBalance(file.content, '(', ')');
  if (braces < 0 || parentheses < 0 || braces > 0 || parentheses > 0) {
    return [`${path.posix.basename(file.relativePath)} parse failed: unbalanced delimiters: ${file.relativePath}`];
  }
  return [];
}

function goModSyntaxDiagnostics(file: ScannedFile): string[] {
  const diagnostics: string[] = [];
  const requireBlockStart = /^[ \t]*require[ \t]*\(/m.exec(file.content);
  if (requireBlockStart) {
    const afterRequireBlockStart = file.content.slice(requireBlockStart.index + requireBlockStart[0]!.length);
    if (!/^[ \t]*\)/m.test(afterRequireBlockStart)) {
      diagnostics.push(`go.mod parse failed: unterminated require block: ${file.relativePath}`);
    }
  }
  return diagnostics;
}

function tomlSyntaxDiagnostics(file: ScannedFile, manifestName: 'Cargo.toml' | 'pyproject.toml'): string[] {
  const diagnostics: string[] = [];
  const lines = file.content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[') && !/^(?:\[[^\]\r\n]+\]|\[\[[^\]\r\n]+\]\])\s*(?:#.*)?$/.test(trimmed)) {
      diagnostics.push(`${manifestName} parse failed: malformed section header at line ${index + 1}: ${file.relativePath}`);
      continue;
    }
    if (hasOddUnescapedDoubleQuotes(line)) {
      diagnostics.push(`${manifestName} parse failed: unterminated string at line ${index + 1}: ${file.relativePath}`);
    }
  }
  return diagnostics;
}

function parseNpmPackageJson(file: ScannedFile): ParsedManifest {
  try {
    const parsed = JSON.parse(file.content) as {
      name?: unknown;
      version?: unknown;
      dependencies?: unknown;
      devDependencies?: unknown;
      peerDependencies?: unknown;
      optionalDependencies?: unknown;
    };
    const name = stringValue(parsed.name);
    if (!name) return { dependencies: [], diagnostics: [`package.json missing package name: ${file.relativePath}`] };
    const pkg = localPackage('npm', name, file.relativePath, name, stringValue(parsed.version), [name]);
    return {
      package: pkg,
      dependencies: [
        ...npmDependencySection(file, parsed.dependencies, 'dependencies'),
        ...npmDependencySection(file, parsed.devDependencies, 'devDependencies'),
        ...npmDependencySection(file, parsed.peerDependencies, 'peerDependencies'),
        ...npmDependencySection(file, parsed.optionalDependencies, 'optionalDependencies')
      ],
      diagnostics: []
    };
  } catch (error) {
    return {
      dependencies: [],
      diagnostics: [`package.json parse failed: ${errorMessage(error)}`]
    };
  }
}

function npmDependencySection(
  file: ScannedFile,
  section: unknown,
  dependencyType: string
): PackageDependency[] {
  if (!section || typeof section !== 'object' || Array.isArray(section)) return [];
  return Object.entries(section as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, version]) => ({
      ecosystem: 'npm',
      name,
      displayName: name,
      version,
      dependencyType,
      confidence: version.startsWith('workspace:') || version.startsWith('file:') ? 'proven' : 'heuristic',
      evidence: evidenceForNeedle(file.content, file.relativePath, JSON.stringify(name))
    }));
}

function parseMavenPom(file: ScannedFile): ParsedManifest {
  const withoutComments = maskXmlComments(file.content);
  const parent = firstXmlBlock(withoutComments, 'parent');
  const projectWithoutParent = maskXmlBlocks(withoutComments, 'parent');
  const directProjectBody = stripMavenNestedModelSections(projectWithoutParent);
  const mavenProperties = mavenPropertyMap(firstXmlBlock(directProjectBody, 'properties'));
  const projectWithoutDeps = removeXmlBlocks(removeXmlBlocks(directProjectBody, 'dependencies'), 'dependencyManagement');
  const parentGroupId = resolveMavenPropertyValue(parent ? xmlTagText(parent, 'groupId') : undefined, mavenProperties);
  const parentArtifactId = resolveMavenPropertyValue(parent ? xmlTagText(parent, 'artifactId') : undefined, mavenProperties);
  const parentVersion = resolveMavenPropertyValue(parent ? xmlTagText(parent, 'version') : undefined, mavenProperties);
  const bootstrapProperties = mavenParentProperties(mavenProperties, parentGroupId, parentArtifactId, parentVersion);
  const groupId = resolveMavenPropertyValue(xmlTagText(projectWithoutDeps, 'groupId'), bootstrapProperties) ?? parentGroupId;
  const artifactId = resolveMavenPropertyValue(xmlTagText(projectWithoutDeps, 'artifactId'), bootstrapProperties);
  const version = resolveMavenPropertyValue(xmlTagText(projectWithoutDeps, 'version'), bootstrapProperties) ?? parentVersion;
  if (!artifactId) {
    return { dependencies: [], diagnostics: [`pom.xml missing artifactId: ${file.relativePath}`] };
  }
  const effectiveProperties = mavenEffectiveProperties(mavenProperties, {
    groupId,
    artifactId,
    version,
    parentGroupId,
    parentArtifactId,
    parentVersion
  });
  const displayName = groupId ? `${groupId}:${artifactId}` : artifactId;
  const pkg = localPackage('maven', displayName, file.relativePath, displayName, version, [
    displayName,
    artifactId
  ]);
  const dependencySource = maskXmlBlocks(directProjectBody, 'dependencyManagement');
  return {
    package: pkg,
    dependencies: xmlBlocks(dependencySource, 'dependency').flatMap((block) => {
      const depGroup = resolveMavenPropertyValue(xmlTagText(block.text, 'groupId'), effectiveProperties);
      const depArtifact = resolveMavenPropertyValue(xmlTagText(block.text, 'artifactId'), effectiveProperties);
      if (!depArtifact) return [];
      const depName = depGroup ? `${depGroup}:${depArtifact}` : depArtifact;
      return [{
        ecosystem: 'maven' as const,
        name: depName,
        displayName: depName,
        version: resolveMavenPropertyValue(xmlTagText(block.text, 'version'), effectiveProperties),
        dependencyType: resolveMavenPropertyValue(xmlTagText(block.text, 'scope'), effectiveProperties) ?? 'dependency',
        confidence: 'heuristic' as const,
        evidence: evidenceLineAt(file.content, file.relativePath, block.index)
      }];
    }),
    diagnostics: []
  };
}

function stripMavenNestedModelSections(content: string): string {
  let stripped = content;
  for (const tagName of ['profiles', 'build', 'reporting']) {
    stripped = maskXmlBlocks(stripped, tagName);
  }
  return stripped;
}

function mavenPropertyMap(propertiesBlock: string | undefined): Map<string, string> {
  const properties = new Map<string, string>();
  if (!propertiesBlock) return properties;
  for (const match of propertiesBlock.matchAll(/<([A-Za-z0-9_.-]+)\b[^>]*>\s*([^<]+?)\s*<\/\1>/g)) {
    properties.set(match[1]!, match[2]!.trim());
  }
  return properties;
}

function mavenEffectiveProperties(
  properties: ReadonlyMap<string, string>,
  values: {
    groupId: string | undefined;
    artifactId: string;
    version: string | undefined;
    parentGroupId: string | undefined;
    parentArtifactId: string | undefined;
    parentVersion: string | undefined;
  }
): Map<string, string> {
  const effective = new Map(properties);
  setMavenPropertyAliases(effective, ['project.groupId', 'pom.groupId'], values.groupId);
  setMavenPropertyAliases(effective, ['project.artifactId', 'pom.artifactId'], values.artifactId);
  setMavenPropertyAliases(effective, ['project.version', 'pom.version'], values.version);
  setMavenPropertyAliases(effective, ['project.parent.groupId', 'pom.parent.groupId'], values.parentGroupId);
  setMavenPropertyAliases(effective, ['project.parent.artifactId', 'pom.parent.artifactId'], values.parentArtifactId);
  setMavenPropertyAliases(effective, ['project.parent.version', 'pom.parent.version'], values.parentVersion);
  return effective;
}

function mavenParentProperties(
  properties: ReadonlyMap<string, string>,
  parentGroupId: string | undefined,
  parentArtifactId: string | undefined,
  parentVersion: string | undefined
): Map<string, string> {
  const effective = new Map(properties);
  setMavenPropertyAliases(effective, ['project.parent.groupId', 'pom.parent.groupId'], parentGroupId);
  setMavenPropertyAliases(effective, ['project.parent.artifactId', 'pom.parent.artifactId'], parentArtifactId);
  setMavenPropertyAliases(effective, ['project.parent.version', 'pom.parent.version'], parentVersion);
  return effective;
}

function setMavenPropertyAliases(
  properties: Map<string, string>,
  names: readonly string[],
  value: string | undefined
): void {
  if (!value) return;
  for (const name of names) properties.set(name, value);
}

function resolveMavenPropertyValue(
  value: string | undefined,
  properties: ReadonlyMap<string, string>
): string | undefined {
  if (!value) return undefined;
  let resolved = value;
  for (let depth = 0; depth < 6; depth += 1) {
    let changed = false;
    resolved = resolved.replace(/\$\{([^}]+)\}/g, (placeholder, key: string) => {
      const replacement = properties.get(key);
      if (replacement === undefined) return placeholder;
      changed = true;
      return replacement;
    });
    if (!changed) break;
  }
  return resolved;
}

function parseGradleBuild(file: ScannedFile, gradleCatalog: GradleVersionCatalog): ParsedManifest {
  const projectPath = gradleProjectPath(file.relativePath);
  const pkg = localPackage('gradle', projectPath, file.relativePath, projectPath, undefined, [projectPath]);
  const dependencies: PackageDependency[] = [];
  for (const match of file.content.matchAll(/project\s*\(\s*['"](:[^'"]+)['"]\s*\)/g)) {
    dependencies.push({
      ecosystem: 'gradle',
      name: match[1]!,
      displayName: match[1]!,
      dependencyType: 'project',
      confidence: 'proven',
      evidence: evidenceLineAt(file.content, file.relativePath, match.index ?? 0)
    });
  }
  const coordinatePattern = /\b(?:api|implementation|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly)\s*(?:\(\s*)?['"]([^:'"]+):([^:'"]+)(?::([^'"]+))?['"]/g;
  for (const match of file.content.matchAll(coordinatePattern)) {
    const displayName = `${match[1]!}:${match[2]!}`;
    dependencies.push({
      ecosystem: 'gradle',
      name: displayName,
      displayName,
      version: match[3],
      dependencyType: 'dependency',
      confidence: 'heuristic',
      evidence: evidenceLineAt(file.content, file.relativePath, match.index ?? 0)
    });
  }
  dependencies.push(...gradleVersionCatalogDependencies(file, gradleCatalog));
  return { package: pkg, dependencies: dedupeDependencies(dependencies), diagnostics: [] };
}

function discoverGradleVersionCatalogs(files: readonly ScannedFile[]): GradleVersionCatalogEntry[] {
  return files
    .filter((file) => isDefaultGradleVersionCatalogPath(file.relativePath))
    .map((file) => ({
      rootDir: gradleCatalogRootDir(file.relativePath),
      catalog: parseGradleVersionCatalog(file.content)
    }))
    .sort((left, right) => right.rootDir.length - left.rootDir.length || left.rootDir.localeCompare(right.rootDir));
}

function parseGradleVersionCatalog(content: string): GradleVersionCatalog {
  const versionEntries: Array<[string, string]> = [];
  const libraryEntries: Array<[string, string]> = [];
  const bundleEntries: Array<[string, string]> = [];
  let section = '';
  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (line.length === 0) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1]!;
      continue;
    }
    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment) continue;
    const alias = assignment[1]!;
    const value = assignment[2]!;
    if (section === 'versions') versionEntries.push([alias, value]);
    if (section === 'libraries') libraryEntries.push([alias, value]);
    if (section === 'bundles') bundleEntries.push([alias, value]);
  }

  const versions = new Map<string, string>();
  for (const [alias, value] of versionEntries) {
    const version = tomlInlineString(value);
    if (version) versions.set(alias, version);
  }

  const libraries = new Map<string, GradleCatalogLibrary>();
  const bundles = new Map<string, readonly string[]>();
  for (const [alias, value] of libraryEntries) {
    const library = gradleCatalogLibrary(alias, value, versions);
    if (library) libraries.set(gradleAccessorName(alias), library);
  }
  for (const [alias, value] of bundleEntries) {
    const bundleAliases = [...value.matchAll(/"([^"]+)"/g)].map((match) => gradleAccessorName(match[1]!));
    if (bundleAliases.length > 0) bundles.set(gradleAccessorName(alias), bundleAliases);
  }
  return { libraries, bundles };
}

function gradleCatalogLibrary(
  alias: string,
  value: string,
  versions: ReadonlyMap<string, string>
): GradleCatalogLibrary | undefined {
  const quotedCoordinate = /^"([^"]+)"/.exec(value)?.[1];
  const moduleCoordinate = /(?:^|[,{\s])module\s*=\s*"([^"]+)"/.exec(value)?.[1];
  const group = /(?:^|[,{\s])group\s*=\s*"([^"]+)"/.exec(value)?.[1];
  const name = /(?:^|[,{\s])name\s*=\s*"([^"]+)"/.exec(value)?.[1];
  const version = /(?:^|[,{\s])version\s*=\s*"([^"]+)"/.exec(value)?.[1];
  const versionRef = /(?:^|[,{\s])version\.ref\s*=\s*"([^"]+)"/.exec(value)?.[1];
  const coordinate = moduleCoordinate ?? (group && name ? `${group}:${name}` : quotedCoordinate);
  if (!coordinate) return undefined;
  const parts = coordinate.split(':');
  if (parts.length < 2) return undefined;
  const displayName = `${parts[0]}:${parts[1]}`;
  const libraryVersion = parts[2] ?? version ?? (versionRef ? versions.get(versionRef) : undefined);
  return {
    name: displayName,
    displayName,
    ...(libraryVersion ? { version: libraryVersion } : {})
  };
}

function gradleVersionCatalogDependencies(
  file: ScannedFile,
  catalog: GradleVersionCatalog
): PackageDependency[] {
  const dependencies: PackageDependency[] = [];
  const accessorPattern = /\blibs((?:\.[A-Za-z_][\w]*)+)/g;
  for (const call of gradleDependencyCalls(file.content)) {
    for (const match of call.argument.matchAll(accessorPattern)) {
      const accessor = match[1]!.replace(/^\./, '');
      if (accessor.startsWith('bundles.')) {
        const bundleAccessor = accessor.slice('bundles.'.length);
        for (const libraryAccessor of catalog.bundles.get(bundleAccessor) ?? []) {
          const library = catalog.libraries.get(libraryAccessor);
          if (library) dependencies.push(gradleCatalogDependency(file, library, call.dependencyType, call.offset));
        }
        continue;
      }
      const library = catalog.libraries.get(accessor);
      if (library) dependencies.push(gradleCatalogDependency(file, library, call.dependencyType, call.offset));
    }
  }
  return dependencies;
}

function gradleVersionCatalogForBuild(
  relativePath: string,
  catalogs: readonly GradleVersionCatalogEntry[]
): GradleVersionCatalog {
  const match = catalogs.find((entry) => pathInsideGradleRoot(relativePath, entry.rootDir));
  return match?.catalog ?? emptyGradleVersionCatalog();
}

function emptyGradleVersionCatalog(): GradleVersionCatalog {
  return { libraries: new Map<string, GradleCatalogLibrary>(), bundles: new Map<string, readonly string[]>() };
}

function isDefaultGradleVersionCatalogPath(relativePath: string): boolean {
  const parts = relativePath.split('/');
  return parts.length >= 2 && parts.at(-2) === 'gradle' && parts.at(-1) === 'libs.versions.toml';
}

function gradleCatalogRootDir(relativePath: string): string {
  const gradleDir = path.posix.dirname(relativePath);
  const rootDir = path.posix.dirname(gradleDir);
  return rootDir === '.' ? '' : rootDir;
}

function pathInsideGradleRoot(relativePath: string, rootDir: string): boolean {
  return rootDir.length === 0 || relativePath === rootDir || relativePath.startsWith(`${rootDir}/`);
}

function gradleDependencyCalls(content: string): Array<{ dependencyType: string; argument: string; offset: number }> {
  const calls: Array<{ dependencyType: string; argument: string; offset: number }> = [];
  const maskedContent = maskCommentsAndStrings(content);
  const configurationPattern = /\b(api|implementation|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly)\s*\(/g;
  for (const match of maskedContent.matchAll(configurationPattern)) {
    const openParen = (match.index ?? 0) + match[0]!.length - 1;
    const closeParen = matchingDelimiterIndex(maskedContent, openParen, '(', ')');
    if (closeParen < 0) continue;
    calls.push({
      dependencyType: match[1]!,
      argument: maskedContent.slice(openParen + 1, closeParen),
      offset: match.index ?? 0
    });
  }

  const linePattern = /\b(api|implementation|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly)\s+(?!\()([^\r\n]+)/g;
  for (const match of maskedContent.matchAll(linePattern)) {
    calls.push({
      dependencyType: match[1]!,
      argument: match[2]!,
      offset: match.index ?? 0
    });
  }
  return calls;
}

function maskCommentsAndStrings(content: string): string {
  let output = '';
  let index = 0;
  let quote: string | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  while (index < content.length) {
    const char = content[index]!;
    const next = content[index + 1];
    if (lineComment) {
      if (char === '\n' || char === '\r') {
        lineComment = false;
        output += char;
      } else {
        output += ' ';
      }
      index += 1;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        output += '  ';
        index += 2;
        blockComment = false;
      } else {
        output += char === '\n' || char === '\r' ? char : ' ';
        index += 1;
      }
      continue;
    }
    if (quote) {
      output += char === '\n' || char === '\r' ? char : ' ';
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      output += '  ';
      index += 2;
      lineComment = true;
      continue;
    }
    if (char === '/' && next === '*') {
      output += '  ';
      index += 2;
      blockComment = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += ' ';
      index += 1;
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function matchingDelimiterIndex(
  content: string,
  openIndex: number,
  open: string,
  close: string
): number {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = openIndex; index < content.length; index += 1) {
    const char = content[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function stripTomlComment(line: string): string {
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#') return line.slice(0, index);
  }
  return line;
}

function tomlInlineString(value: string): string | undefined {
  return /^\s*"([^"]+)"/.exec(value)?.[1];
}

function gradleCatalogDependency(
  file: ScannedFile,
  library: GradleCatalogLibrary,
  dependencyType: string,
  offset: number
): PackageDependency {
  return {
    ecosystem: 'gradle',
    name: library.name,
    displayName: library.displayName,
    version: library.version,
    dependencyType,
    confidence: 'heuristic',
    evidence: evidenceLineAt(file.content, file.relativePath, offset)
  };
}

function gradleAccessorName(alias: string): string {
  return alias.replace(/[-_.]+/g, '.');
}

function parseGoMod(file: ScannedFile): ParsedManifest {
  const moduleMatch = /^[ \t]*module[ \t]+(\S+)/m.exec(file.content);
  if (!moduleMatch) return { dependencies: [], diagnostics: [`go.mod missing module declaration: ${file.relativePath}`] };
  const modulePath = moduleMatch[1]!;
  const pkg = localPackage('go', modulePath, file.relativePath, modulePath, undefined, [modulePath]);
  const dependencies: PackageDependency[] = [];
  for (const match of file.content.matchAll(/^[ \t]*require[ \t]+(\S+)[ \t]+(\S+)/gm)) {
    dependencies.push(goDependency(file, match[1]!, match[2], match.index ?? 0));
  }
  const requireBlock = /^[ \t]*require[ \t]*\(([\s\S]*?)^[ \t]*\)/gm.exec(file.content);
  if (requireBlock) {
    const blockStart = requireBlock.index + requireBlock[0]!.indexOf(requireBlock[1]!);
    const lines = requireBlock[1]!.split(/\r?\n/);
    let offset = blockStart;
    for (const line of lines) {
      const depMatch = /^[ \t]*(\S+)[ \t]+(\S+)/.exec(line.replace(/\/\/.*$/, ''));
      if (depMatch) dependencies.push(goDependency(file, depMatch[1]!, depMatch[2], offset));
      offset += line.length + 1;
    }
  }
  return { package: pkg, dependencies: dedupeDependencies(dependencies), diagnostics: [] };
}

function goDependency(
  file: ScannedFile,
  modulePath: string,
  version: string | undefined,
  offset: number
): PackageDependency {
  return {
    ecosystem: 'go',
    name: modulePath,
    displayName: modulePath,
    version,
    dependencyType: 'require',
    confidence: 'heuristic',
    evidence: evidenceLineAt(file.content, file.relativePath, offset)
  };
}

type GoLocalReplaceAlias = {
  modulePath: string;
  targetManifestPath: string;
};

type GoPathDirective = {
  value: string;
  offset: number;
};

function goLocalReplaceAliases(file: ScannedFile): GoLocalReplaceAlias[] {
  const aliases: GoLocalReplaceAlias[] = [];
  for (const replacement of goReplaceDirectives(file.content)) {
    const modulePath = goDirectiveFirstToken(replacement.source);
    const targetPath = goDirectiveFirstToken(replacement.target);
    const targetManifestPath = targetPath ? goLocalModuleManifestPath(file.relativePath, targetPath) : undefined;
    if (!modulePath || !targetManifestPath) continue;
    aliases.push({ modulePath, targetManifestPath });
  }
  return aliases;
}

function goReplaceDirectives(content: string): Array<{ source: string; target: string }> {
  const directives: Array<{ source: string; target: string }> = [];
  let inBlock = false;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = stripGoDirectiveComment(line).trim();
    if (!trimmed) continue;
    if (inBlock) {
      if (trimmed === ')') {
        inBlock = false;
        continue;
      }
      const blockMatch = /^(.+?)\s+=>\s+(\S+(?:\s+\S+)?)$/.exec(trimmed);
      if (blockMatch) directives.push({ source: blockMatch[1]!, target: blockMatch[2]! });
      continue;
    }
    if (/^replace\s*\($/.test(trimmed)) {
      inBlock = true;
      continue;
    }
    const lineMatch = /^replace\s+(.+?)\s+=>\s+(\S+(?:\s+\S+)?)$/.exec(trimmed);
    if (lineMatch) directives.push({ source: lineMatch[1]!, target: lineMatch[2]! });
  }
  return directives;
}

function goWorkUseTargets(
  file: ScannedFile,
  filePathSet: ReadonlySet<string>
): Array<{ path: string; evidence: PendingEvidence }> {
  return goWorkUseDirectives(file.content)
    .flatMap((directive) => {
      const targetManifestPath = goLocalModuleManifestPath(file.relativePath, directive.value);
      if (!targetManifestPath || !filePathSet.has(targetManifestPath)) return [];
      return [{
        path: targetManifestPath,
        evidence: evidenceLineAt(file.content, file.relativePath, directive.offset)
      }];
    });
}

function goWorkUseDirectives(content: string): GoPathDirective[] {
  const directives: GoPathDirective[] = [];
  let inBlock = false;
  let offset = 0;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = stripGoDirectiveComment(line).trim();
    if (trimmed) {
      if (inBlock) {
        if (trimmed === ')') {
          inBlock = false;
        } else {
          const value = goDirectiveFirstToken(trimmed);
          if (value) directives.push({ value, offset });
        }
      } else if (/^use\s*\($/.test(trimmed)) {
        inBlock = true;
      } else {
        const lineMatch = /^use\s+(\S+)/.exec(trimmed);
        if (lineMatch) directives.push({ value: unquoteGoDirectiveToken(lineMatch[1]!), offset });
      }
    }
    offset += line.length + 1;
  }
  return directives;
}

function goLocalModuleManifestPath(relativePath: string, moduleDir: string): string | undefined {
  const unquoted = unquoteGoDirectiveToken(moduleDir);
  if (!isLocalGoModulePath(unquoted)) return undefined;
  const manifestPath = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), unquoted, 'go.mod'));
  if (manifestPath === '..' || manifestPath.startsWith('../') || path.posix.isAbsolute(manifestPath)) return undefined;
  return manifestPath;
}

function isLocalGoModulePath(value: string): boolean {
  return value.startsWith('./') || value.startsWith('../');
}

function goDirectiveFirstToken(value: string): string | undefined {
  const token = value.trim().split(/\s+/)[0];
  return token ? unquoteGoDirectiveToken(token) : undefined;
}

function unquoteGoDirectiveToken(value: string): string {
  return value.replace(/^"(.+)"$/, '$1');
}

function stripGoDirectiveComment(line: string): string {
  return line.replace(/\s+\/\/.*$/, '').replace(/^\/\/.*$/, '');
}

function parseCargoToml(
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

function cargoLocalManifestPath(relativePath: string, crateDir: string): string | undefined {
  if (path.posix.isAbsolute(crateDir)) return undefined;
  const manifestPath = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), crateDir, 'Cargo.toml'));
  if (manifestPath === '..' || manifestPath.startsWith('../') || path.posix.isAbsolute(manifestPath)) return undefined;
  return manifestPath;
}

function cargoManifestDir(relativePath: string): string {
  const dir = path.posix.dirname(relativePath);
  return dir === '.' ? '' : dir;
}

function parsePyprojectToml(file: ScannedFile): ParsedManifest {
  const projectName = tomlStringInSection(file.content, 'project', 'name') ?? tomlStringInSection(file.content, 'tool.poetry', 'name');
  if (!projectName) return { dependencies: [], diagnostics: [`pyproject.toml missing [project].name or [tool.poetry].name: ${file.relativePath}`] };
  const version = tomlStringInSection(file.content, 'project', 'version') ?? tomlStringInSection(file.content, 'tool.poetry', 'version');
  const pkg = localPackage('python', projectName, file.relativePath, projectName, version, [normalizePythonPackageName(projectName)]);
  return {
    package: pkg,
    dependencies: pyprojectDependencies(file),
    diagnostics: []
  };
}

function pyprojectDependencies(file: ScannedFile): PackageDependency[] {
  const dependencies: PackageDependency[] = [];
  const project = tomlSectionBlock(file.content, 'project');
  if (project) {
    for (const assignment of tomlStringArrayAssignments(project).filter((item) => item.key === 'dependencies')) {
      dependencies.push(...pythonStringDependencies(file, assignment.values, 'dependencies'));
    }
  }

  const optionalDependencies = tomlSectionBlock(file.content, 'project.optional-dependencies');
  if (optionalDependencies) {
    for (const assignment of tomlStringArrayAssignments(optionalDependencies)) {
      dependencies.push(...pythonStringDependencies(file, assignment.values, `optional-dependencies:${assignment.key}`));
    }
  }

  const dependencyGroups = tomlSectionBlock(file.content, 'dependency-groups');
  if (dependencyGroups) {
    for (const assignment of tomlStringArrayAssignments(dependencyGroups)) {
      dependencies.push(...pythonStringDependencies(file, assignment.values, `dependency-groups:${assignment.key}`));
    }
  }

  for (const section of tomlSectionsMatching(file.content, /^tool\.poetry\.group\.([^.]+)\.dependencies$/)) {
    const groupName = /^tool\.poetry\.group\.([^.]+)\.dependencies$/.exec(section.name)?.[1];
    if (!groupName) continue;
    dependencies.push(...poetryGroupDependencies(file, section, groupName));
  }

  return dedupeDependencies(dependencies);
}

function pythonStringDependencies(
  file: ScannedFile,
  values: readonly TomlStringValue[],
  dependencyType: string
): PackageDependency[] {
  return values.flatMap((value) => {
    const name = pythonDependencyName(value.value);
    if (!name) return [];
    const normalizedName = normalizePythonPackageName(name);
    return [{
      ecosystem: 'python' as const,
      name: normalizedName,
      displayName: normalizedName,
      dependencyType,
      confidence: 'heuristic' as const,
      evidence: evidenceLineAt(file.content, file.relativePath, value.offset)
    }];
  });
}

function poetryGroupDependencies(
  file: ScannedFile,
  section: TomlSectionBlock,
  groupName: string
): PackageDependency[] {
  const dependencies: PackageDependency[] = [];
  let lineOffset = 0;
  for (const line of section.text.split(/\r?\n/)) {
    const uncommented = stripTomlComment(line);
    const dependencyMatch = /^[ \t]*([A-Za-z0-9_.-]+)[ \t]*=/.exec(uncommented);
    if (dependencyMatch) {
      const name = normalizePythonPackageName(dependencyMatch[1]!);
      if (name !== 'python') {
        const value = uncommented.slice(dependencyMatch[0]!.length);
        dependencies.push({
          ecosystem: 'python',
          name,
          displayName: name,
          version: tomlInlineString(value) ?? tomlInlineStringField(value, 'version'),
          dependencyType: `poetry-group:${groupName}`,
          confidence: 'heuristic',
          evidence: evidenceLineAt(file.content, file.relativePath, section.start + lineOffset + line.indexOf(dependencyMatch[1]!))
        });
      }
    }
    lineOffset += line.length + 1;
  }
  return dedupeDependencies(dependencies);
}

function localPackage(
  ecosystem: PackageEcosystem,
  name: string,
  manifestPath: string,
  displayName: string,
  version: string | undefined,
  aliases: readonly string[]
): LocalPackage {
  return {
    ecosystem,
    name,
    manifestPath,
    displayName,
    ...(version ? { version } : {}),
    aliases: [...new Set([name, displayName, ...aliases])]
  };
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

function evidenceForNeedle(content: string, filePath: string, needle: string): PendingEvidence {
  const index = content.indexOf(needle);
  return evidenceLineAt(content, filePath, index < 0 ? 0 : index);
}

function evidenceLineAt(content: string, filePath: string, offset: number): PendingEvidence {
  const safeOffset = Math.max(0, Math.min(offset, content.length));
  const lineStart = content.lastIndexOf('\n', Math.max(0, safeOffset - 1)) + 1;
  const lineEndIndex = content.indexOf('\n', safeOffset);
  const lineEnd = lineEndIndex < 0 ? content.length : lineEndIndex;
  const line = content.slice(lineStart, lineEnd);
  const start = offsetPosition(content, lineStart);
  const end = offsetPosition(content, lineEnd);
  return {
    file: filePath,
    snippet: line.trim(),
    confidence: 'proven',
    startLine: start.line,
    endLine: end.line,
    startCol: start.col,
    endCol: end.col
  };
}

function offsetPosition(content: string, index: number): { line: number; col: number } {
  const prefix = content.slice(0, Math.max(0, index));
  const lines = prefix.split(/\r?\n/);
  return {
    line: lines.length,
    col: (lines.at(-1)?.length ?? 0) + 1
  };
}

function packageKey(ecosystem: PackageEcosystem, name: string): string {
  const normalized = ecosystem === 'python' ? normalizePythonPackageName(name) : name;
  return `${ecosystem}:${normalized}`;
}

function gradleProjectPath(relativePath: string): string {
  const dir = path.posix.dirname(relativePath);
  if (dir === '.') return ':';
  return `:${dir.split('/').filter(Boolean).join(':')}`;
}

function tomlStringInSection(content: string, sectionName: string, key: string): string | undefined {
  const section = tomlSection(content, sectionName);
  if (!section) return undefined;
  const match = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]+)"`, 'm').exec(section);
  return match?.[1];
}

function tomlSection(content: string, sectionName: string): string | undefined {
  return tomlSectionBlock(content, sectionName)?.text;
}

function tomlSectionBlock(content: string, sectionName: string): TomlSectionBlock | undefined {
  return tomlSections(content).find((section) => section.name === sectionName);
}

function tomlSectionsMatching(content: string, pattern: RegExp): TomlSectionBlock[] {
  return tomlSections(content).filter((section) => pattern.test(section.name));
}

function tomlSections(content: string): TomlSectionBlock[] {
  const headerPattern = /^\s*(?:\[([^\[\]\r\n]+)\]|\[\[([^\[\]\r\n]+)\]\])\s*(?:#.*)?$/gm;
  const headers = [...content.matchAll(headerPattern)].map((match) => ({
    name: match[1] ?? match[2] ?? '',
    headerStart: match.index ?? 0,
    bodyStart: (match.index ?? 0) + match[0]!.length
  }));
  return headers.map((header, index) => {
    const nextHeader = headers[index + 1];
    return {
      name: header.name,
      text: content.slice(header.bodyStart, nextHeader?.headerStart ?? content.length),
      start: header.bodyStart
    };
  });
}

function tomlStringArrayAssignments(section: TomlSectionBlock): TomlStringArrayAssignment[] {
  const assignments: TomlStringArrayAssignment[] = [];
  const assignmentPattern = /^[ \t]*([A-Za-z0-9_.-]+)[ \t]*=[ \t]*\[/gm;
  let match: RegExpExecArray | null;
  while ((match = assignmentPattern.exec(section.text)) !== null) {
    const openBracket = match.index + match[0]!.lastIndexOf('[');
    const closeBracket = matchingDelimiterIndex(section.text, openBracket, '[', ']');
    if (closeBracket < 0) continue;
    const arrayText = section.text.slice(openBracket, closeBracket + 1);
    assignments.push({
      key: match[1]!,
      values: tomlArrayStringValues(arrayText, section.start + openBracket)
    });
    assignmentPattern.lastIndex = closeBracket + 1;
  }
  return assignments;
}

function tomlArrayStringValues(arrayText: string, arrayOffset: number): TomlStringValue[] {
  const values: TomlStringValue[] = [];
  let quote: string | undefined;
  let stringStart = -1;
  let capture = false;
  let escaped = false;
  let braceDepth = 0;
  let comment = false;
  for (let index = 1; index < arrayText.length - 1; index += 1) {
    const char = arrayText[index]!;
    if (comment) {
      if (char === '\n' || char === '\r') comment = false;
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        if (capture) {
          values.push({
            value: arrayText.slice(stringStart + 1, index),
            offset: arrayOffset + stringStart
          });
        }
        quote = undefined;
        capture = false;
        stringStart = -1;
      }
      continue;
    }
    if (char === '#') {
      comment = true;
      continue;
    }
    if (char === '{') {
      braceDepth += 1;
      continue;
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      stringStart = index;
      capture = braceDepth === 0;
    }
  }
  return values;
}

function tomlInlineStringField(value: string, key: string): string | undefined {
  const match = new RegExp(`(?:^|[,{\\s])${escapeRegExp(key)}\\s*=\\s*"([^"]+)"`).exec(value);
  return match?.[1];
}

function pythonDependencyName(specifier: string): string | undefined {
  const match = /^([A-Za-z0-9_.-]+)/.exec(specifier.trim());
  return match?.[1];
}

function normalizePythonPackageName(name: string): string {
  return name.replace(/[-_.]+/g, '-').toLowerCase();
}

function xmlBlocks(content: string, tagName: string): Array<{ text: string; index: number }> {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'g');
  const blocks: Array<{ text: string; index: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    blocks.push({ text: match[0]!, index: match.index });
  }
  return blocks;
}

function firstXmlBlock(content: string, tagName: string): string | undefined {
  return xmlBlocks(content, tagName)[0]?.text;
}

function removeXmlBlocks(content: string, tagName: string): string {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'g');
  return content.replace(pattern, '');
}

function maskXmlBlocks(content: string, tagName: string): string {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, 'g');
  return content.replace(pattern, (match) => match.replace(/[^\r\n]/g, ' '));
}

function xmlTagText(content: string, tagName: string): string | undefined {
  const match = new RegExp(`<${tagName}\\b[^>]*>\\s*([^<]+?)\\s*<\\/${tagName}>`).exec(content);
  return match?.[1]?.trim();
}

function stripXmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '');
}

function maskXmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\r\n]/g, ' '));
}

function dedupeDependencies(dependencies: readonly PackageDependency[]): PackageDependency[] {
  const byKey = new Map<string, PackageDependency>();
  for (const dependency of dependencies) {
    const key = `${dependency.ecosystem}:${dependency.name}:${dependency.dependencyType}`;
    if (!byKey.has(key)) byKey.set(key, dependency);
  }
  return [...byKey.values()].sort((left, right) =>
    left.ecosystem.localeCompare(right.ecosystem) ||
    left.name.localeCompare(right.name) ||
    left.dependencyType.localeCompare(right.dependencyType)
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delimiterBalance(content: string, open: string, close: string): number {
  let balance = 0;
  let quote: string | undefined;
  let escaped = false;
  for (const char of content) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === open) balance += 1;
    if (char === close) balance -= 1;
  }
  return balance;
}

function hasOddUnescapedDoubleQuotes(line: string): boolean {
  let count = 0;
  let escaped = false;
  for (const char of line) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') count += 1;
  }
  return count % 2 === 1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
