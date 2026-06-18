import type { ScannedFile } from '../../types.js';
import {
  dedupeDependencies,
  errorMessage,
  evidenceForNeedle,
  localPackage,
  stringValue
} from './shared.js';
import type { ParsedManifest, PackageDependency } from './types.js';

export type ParsedNpmLockfile = {
  manifestPath: string;
  lockfilePath: string;
  dependencies: PackageDependency[];
  diagnostics: string[];
};

export function parseNpmPackageJson(
  file: ScannedFile,
  lockfile?: ParsedNpmLockfile
): ParsedManifest {
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
    const manifestDependencies = [
      ...npmDependencySection(file, parsed.dependencies, 'dependencies'),
      ...npmDependencySection(file, parsed.devDependencies, 'devDependencies'),
      ...npmDependencySection(file, parsed.peerDependencies, 'peerDependencies'),
      ...npmDependencySection(file, parsed.optionalDependencies, 'optionalDependencies')
    ];
    const manifestDependencyNames = new Set(manifestDependencies.map((dependency) => dependency.name));
    const lockfileDependencies = (lockfile?.dependencies ?? [])
      .filter((dependency) => !manifestDependencyNames.has(dependency.name));
    return {
      package: pkg,
      dependencies: dedupeDependencies([...manifestDependencies, ...lockfileDependencies]),
      diagnostics: lockfile?.diagnostics ?? []
    };
  } catch (error) {
    return {
      dependencies: [],
      diagnostics: [`package.json parse failed: ${errorMessage(error)}`]
    };
  }
}

export function discoverNpmLockfiles(files: readonly ScannedFile[]): ReadonlyMap<string, ParsedNpmLockfile> {
  const lockfiles = new Map<string, ParsedNpmLockfile>();
  for (const file of files) {
    if (file.relativePath.endsWith('package-lock.json')) {
      const parsed = parseNpmLockfile(file);
      lockfiles.set(parsed.manifestPath, parsed);
    }
  }
  return lockfiles;
}

export function npmLockfileManifestPath(lockfilePath: string): string {
  const prefix = lockfilePath.slice(0, -'package-lock.json'.length);
  return `${prefix}package.json`;
}

export function parseNpmLockfile(file: ScannedFile): ParsedNpmLockfile {
  try {
    const parsed = JSON.parse(file.content) as {
      packages?: unknown;
      dependencies?: unknown;
    };
    return {
      manifestPath: npmLockfileManifestPath(file.relativePath),
      lockfilePath: file.relativePath,
      dependencies: dedupeDependencies([
        ...packageLockPackagesDependencies(file, parsed.packages),
        ...packageLockV1Dependencies(file, parsed.dependencies)
      ]),
      diagnostics: []
    };
  } catch (error) {
    return {
      manifestPath: npmLockfileManifestPath(file.relativePath),
      lockfilePath: file.relativePath,
      dependencies: [],
      diagnostics: [`package-lock.json parse failed: ${errorMessage(error)}`]
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

function packageLockPackagesDependencies(file: ScannedFile, packages: unknown): PackageDependency[] {
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) return [];
  return Object.entries(packages as Record<string, unknown>).flatMap(([packagePath, value]) => {
    if (packagePath === '' || !value || typeof value !== 'object' || Array.isArray(value)) return [];
    const entry = value as { version?: unknown; link?: unknown };
    if (entry.link === true) return [];
    const name = packageNameFromNodeModulesPath(packagePath);
    if (!name) return [];
    return [{
      ecosystem: 'npm',
      name,
      displayName: name,
      version: stringValue(entry.version),
      dependencyType: 'lockfile:transitive',
      confidence: 'proven',
      evidence: evidenceForNeedle(file.content, file.relativePath, JSON.stringify(packagePath))
    }];
  });
}

function packageLockV1Dependencies(file: ScannedFile, dependencies: unknown): PackageDependency[] {
  const output: PackageDependency[] = [];
  visitLockV1Dependencies(file, dependencies, output, true);
  return output;
}

function visitLockV1Dependencies(
  file: ScannedFile,
  dependencies: unknown,
  output: PackageDependency[],
  root: boolean
): void {
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return;
  for (const [name, value] of Object.entries(dependencies as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as { version?: unknown; dependencies?: unknown };
    if (!root) {
      output.push({
        ecosystem: 'npm',
        name,
        displayName: name,
        version: stringValue(entry.version),
        dependencyType: 'lockfile:transitive',
        confidence: 'proven',
        evidence: evidenceForNeedle(file.content, file.relativePath, JSON.stringify(name))
      });
    }
    visitLockV1Dependencies(file, entry.dependencies, output, false);
  }
}

function packageNameFromNodeModulesPath(packagePath: string): string | undefined {
  const parts = packagePath.split('/');
  const nodeModulesIndex = parts.lastIndexOf('node_modules');
  if (nodeModulesIndex < 0) return undefined;
  const first = parts[nodeModulesIndex + 1];
  if (!first) return undefined;
  if (first.startsWith('@')) {
    const second = parts[nodeModulesIndex + 2];
    return second ? `${first}/${second}` : undefined;
  }
  return first;
}
