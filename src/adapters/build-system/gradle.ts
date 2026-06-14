import path from 'node:path';

import type { ScannedFile } from '../../types.js';
import {
  dedupeDependencies,
  evidenceLineAt,
  localPackage,
  maskCommentsAndStrings,
  matchingDelimiterIndex,
  stripTomlComment,
  tomlInlineString
} from './shared.js';
import type {
  GradleCatalogLibrary,
  GradleVersionCatalog,
  GradleVersionCatalogEntry,
  PackageDependency,
  ParsedManifest
} from './types.js';

export function gradleSyntaxDiagnostics(file: ScannedFile): string[] {
  const braces = delimiterBalance(file.content, '{', '}');
  const parentheses = delimiterBalance(file.content, '(', ')');
  if (braces < 0 || parentheses < 0 || braces > 0 || parentheses > 0) {
    return [`${path.posix.basename(file.relativePath)} parse failed: unbalanced delimiters: ${file.relativePath}`];
  }
  return [];
}

export function parseGradleBuild(file: ScannedFile, gradleCatalog: GradleVersionCatalog): ParsedManifest {
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

export function discoverGradleVersionCatalogs(files: readonly ScannedFile[]): GradleVersionCatalogEntry[] {
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

export function gradleVersionCatalogForBuild(
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

function gradleProjectPath(relativePath: string): string {
  const dir = path.posix.dirname(relativePath);
  if (dir === '.') return ':';
  return `:${dir.split('/').filter(Boolean).join(':')}`;
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
