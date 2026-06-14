import type { ScannedFile } from '../../types.js';
import { errorMessage, evidenceForNeedle, localPackage, stringValue } from './shared.js';
import type { ParsedManifest, PackageDependency } from './types.js';

export function parseNpmPackageJson(file: ScannedFile): ParsedManifest {
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
