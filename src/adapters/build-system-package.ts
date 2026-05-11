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
type BuildManifestKind = PackageEcosystem | 'gradle-settings' | 'go-work' | 'pnpm-workspace';

const buildSystemCapabilities: readonly AdapterCapability[] = ['packages', 'references'];

export class BuildSystemPackageAdapter implements SemanticAdapter {
  readonly id = BUILD_SYSTEM_PACKAGE_ADAPTER_ID;
  readonly version = BUILD_SYSTEM_PACKAGE_ADAPTER_VERSION;
  readonly capabilities = buildSystemCapabilities;

  supports(file: ScannedFile): boolean {
    return buildManifestKind(file.relativePath) !== undefined;
  }

  start(ctx: ExtractCtx, files: readonly ScannedFile[]): AdapterRun {
    const packageIndex = discoverLocalPackages(files);
    const filePathSet = new Set(ctx.indexedFiles.map((file) => file.relativePath));
    return {
      async *process(file: ScannedFile): AsyncIterable<IndexEvent> {
        yield* extractBuildSystemEvents(file, packageIndex, filePathSet);
      }
    };
  }
}

async function* extractBuildSystemEvents(
  file: ScannedFile,
  packageIndex: PackageIndex,
  filePathSet: ReadonlySet<string>
): AsyncIterable<IndexEvent> {
  const parsed = parseBuildManifest(file);
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
  for (const target of inferManifestTextTargets(file, filePathSet)) {
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
    const localTarget = packageIndex.get(packageKey(dependency.ecosystem, dependency.name));
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

function discoverLocalPackages(files: readonly ScannedFile[]): PackageIndex {
  const packages = new Map<string, LocalPackage>();
  for (const file of files) {
    const parsed = parseBuildManifest(file);
    if (!parsed.package) continue;
    for (const alias of parsed.package.aliases) {
      packages.set(packageKey(parsed.package.ecosystem, alias), parsed.package);
    }
  }
  return packages;
}

function parseBuildManifest(file: ScannedFile): ParsedManifest {
  const kind = buildManifestKind(file.relativePath);
  const parsed =
    kind === 'npm' ? parseNpmPackageJson(file)
    : kind === 'maven' ? parseMavenPom(file)
    : kind === 'gradle' ? parseGradleBuild(file)
    : kind === 'go' ? parseGoMod(file)
    : kind === 'cargo' ? parseCargoToml(file)
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
  const requireBlockStart = /^\s*require\s*\(/m.exec(file.content);
  if (requireBlockStart) {
    const afterRequireBlockStart = file.content.slice(requireBlockStart.index + requireBlockStart[0]!.length);
    if (!/^\s*\)/m.test(afterRequireBlockStart)) {
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
  const withoutComments = stripXmlComments(file.content);
  const parent = firstXmlBlock(withoutComments, 'parent');
  const projectWithoutParent = removeXmlBlocks(withoutComments, 'parent');
  const projectWithoutDeps = removeXmlBlocks(removeXmlBlocks(projectWithoutParent, 'dependencies'), 'dependencyManagement');
  const groupId = xmlTagText(projectWithoutDeps, 'groupId') ?? (parent ? xmlTagText(parent, 'groupId') : undefined);
  const artifactId = xmlTagText(projectWithoutDeps, 'artifactId');
  if (!artifactId) {
    return { dependencies: [], diagnostics: [`pom.xml missing artifactId: ${file.relativePath}`] };
  }
  const displayName = groupId ? `${groupId}:${artifactId}` : artifactId;
  const pkg = localPackage('maven', displayName, file.relativePath, displayName, xmlTagText(projectWithoutDeps, 'version'), [
    displayName,
    artifactId
  ]);
  const dependencySource = removeXmlBlocks(withoutComments, 'dependencyManagement');
  return {
    package: pkg,
    dependencies: xmlBlocks(dependencySource, 'dependency').flatMap((block) => {
      const depGroup = xmlTagText(block.text, 'groupId');
      const depArtifact = xmlTagText(block.text, 'artifactId');
      if (!depArtifact) return [];
      const depName = depGroup ? `${depGroup}:${depArtifact}` : depArtifact;
      return [{
        ecosystem: 'maven' as const,
        name: depName,
        displayName: depName,
        version: xmlTagText(block.text, 'version'),
        dependencyType: xmlTagText(block.text, 'scope') ?? 'dependency',
        confidence: 'heuristic' as const,
        evidence: evidenceLineAt(file.content, file.relativePath, block.index)
      }];
    }),
    diagnostics: []
  };
}

function parseGradleBuild(file: ScannedFile): ParsedManifest {
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
  return { package: pkg, dependencies: dedupeDependencies(dependencies), diagnostics: [] };
}

function parseGoMod(file: ScannedFile): ParsedManifest {
  const moduleMatch = /^\s*module\s+(\S+)/m.exec(file.content);
  if (!moduleMatch) return { dependencies: [], diagnostics: [`go.mod missing module declaration: ${file.relativePath}`] };
  const modulePath = moduleMatch[1]!;
  const pkg = localPackage('go', modulePath, file.relativePath, modulePath, undefined, [modulePath]);
  const dependencies: PackageDependency[] = [];
  for (const match of file.content.matchAll(/^\s*require\s+(\S+)\s+(\S+)/gm)) {
    dependencies.push(goDependency(file, match[1]!, match[2], match.index ?? 0));
  }
  const requireBlock = /^\s*require\s*\(([\s\S]*?)^\s*\)/gm.exec(file.content);
  if (requireBlock) {
    const blockStart = requireBlock.index + requireBlock[0]!.indexOf(requireBlock[1]!);
    const lines = requireBlock[1]!.split(/\r?\n/);
    let offset = blockStart;
    for (const line of lines) {
      const depMatch = /^\s*(\S+)\s+(\S+)/.exec(line.replace(/\/\/.*$/, ''));
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

function parseCargoToml(file: ScannedFile): ParsedManifest {
  const packageName = tomlStringInSection(file.content, 'package', 'name');
  if (!packageName) return { dependencies: [], diagnostics: [`Cargo.toml missing [package].name: ${file.relativePath}`] };
  const pkg = localPackage('cargo', packageName, file.relativePath, packageName, tomlStringInSection(file.content, 'package', 'version'), [packageName]);
  const dependencies: PackageDependency[] = [];
  let section = '';
  const lines = file.content.split(/\r?\n/);
  let offset = 0;
  for (const line of lines) {
    const sectionMatch = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1]!;
    } else if (/^(?:dependencies|dev-dependencies|build-dependencies)$/.test(section)) {
      const dependencyMatch = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
      if (dependencyMatch) {
        dependencies.push({
          ecosystem: 'cargo',
          name: dependencyMatch[1]!,
          displayName: dependencyMatch[1]!,
          dependencyType: section,
          confidence: line.includes('path') ? 'proven' : 'heuristic',
          evidence: evidenceLineAt(file.content, file.relativePath, offset)
        });
      }
    }
    offset += line.length + 1;
  }
  return { package: pkg, dependencies: dedupeDependencies(dependencies), diagnostics: [] };
}

function parsePyprojectToml(file: ScannedFile): ParsedManifest {
  const projectName = tomlStringInSection(file.content, 'project', 'name');
  if (!projectName) return { dependencies: [], diagnostics: [`pyproject.toml missing [project].name: ${file.relativePath}`] };
  const pkg = localPackage('python', projectName, file.relativePath, projectName, tomlStringInSection(file.content, 'project', 'version'), [normalizePythonPackageName(projectName)]);
  return {
    package: pkg,
    dependencies: pyprojectDependencies(file),
    diagnostics: []
  };
}

function pyprojectDependencies(file: ScannedFile): PackageDependency[] {
  const dependencies: PackageDependency[] = [];
  const start = file.content.search(/^\s*dependencies\s*=\s*\[/m);
  if (start < 0) return dependencies;
  const end = file.content.indexOf(']', start);
  const block = file.content.slice(start, end < 0 ? file.content.length : end);
  for (const match of block.matchAll(/"([^"]+)"/g)) {
    const name = pythonDependencyName(match[1]!);
    if (!name) continue;
    dependencies.push({
      ecosystem: 'python',
      name: normalizePythonPackageName(name),
      displayName: normalizePythonPackageName(name),
      dependencyType: 'dependencies',
      confidence: 'heuristic',
      evidence: evidenceLineAt(file.content, file.relativePath, start + (match.index ?? 0))
    });
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
  const pattern = new RegExp(`^\\s*\\[${escapeRegExp(sectionName)}\\]\\s*$`, 'm');
  const match = pattern.exec(content);
  if (!match) return undefined;
  const start = (match.index ?? 0) + match[0]!.length;
  const rest = content.slice(start);
  const next = /^\s*\[[^\]]+\]\s*$/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
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

function xmlTagText(content: string, tagName: string): string | undefined {
  const match = new RegExp(`<${tagName}\\b[^>]*>\\s*([^<]+?)\\s*<\\/${tagName}>`).exec(content);
  return match?.[1]?.trim();
}

function stripXmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '');
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
