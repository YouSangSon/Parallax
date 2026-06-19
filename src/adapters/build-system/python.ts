import type { ScannedFile } from '../../types.js';
import {
  buildManifestKind,
  dedupeDependencies,
  evidenceForNeedle,
  evidenceLineAt,
  localPackage,
  normalizePythonPackageName,
  pythonDependencyName,
  stripTomlComment,
  tomlInlineString,
  tomlInlineStringField,
  tomlSectionBlock,
  tomlSectionsMatching,
  tomlStringArrayAssignments,
  tomlStringInSection
} from './shared.js';
import type { PackageDependency, ParsedManifest, TomlSectionBlock, TomlStringValue } from './types.js';

export function parsePyprojectToml(file: ScannedFile, lockfile?: ParsedPoetryLockfile): ParsedManifest {
  const projectName = tomlStringInSection(file.content, 'project', 'name') ?? tomlStringInSection(file.content, 'tool.poetry', 'name');
  if (!projectName) return { dependencies: [], diagnostics: [`pyproject.toml missing [project].name or [tool.poetry].name: ${file.relativePath}`] };
  const version = tomlStringInSection(file.content, 'project', 'version') ?? tomlStringInSection(file.content, 'tool.poetry', 'version');
  const pkg = localPackage('python', projectName, file.relativePath, projectName, version, [normalizePythonPackageName(projectName)]);
  const manifestDependencies = pyprojectDependencies(file);
  const manifestNames = new Set(manifestDependencies.map((dependency) => dependency.name));
  const lockfileDependencies = (lockfile?.dependencies ?? []).filter(
    (dependency) => !manifestNames.has(dependency.name)
  );
  return {
    package: pkg,
    dependencies: dedupeDependencies([...manifestDependencies, ...lockfileDependencies]),
    diagnostics: lockfile?.diagnostics ?? []
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

export type ParsedPoetryLockfile = {
  manifestPath: string;
  lockfilePath: string;
  dependencies: PackageDependency[];
  diagnostics: string[];
};

// poetry.lock lives next to pyproject.toml.
export function poetryLockfileManifestPath(lockfilePath: string): string {
  const prefix = lockfilePath.slice(0, -'poetry.lock'.length);
  return `${prefix}pyproject.toml`;
}

export function discoverPoetryLockfiles(
  files: readonly ScannedFile[]
): ReadonlyMap<string, ParsedPoetryLockfile> {
  const lockfiles = new Map<string, ParsedPoetryLockfile>();
  for (const file of files) {
    if (buildManifestKind(file.relativePath) !== 'poetry-lock') continue;
    const parsed = parsePoetryLockfile(file);
    lockfiles.set(parsed.manifestPath, parsed);
  }
  return lockfiles;
}

// Each `[[package]]` block is a resolved transitive dependency; blocks whose
// `[package.source]` is a local `directory`/`file` are skipped so local path
// deps stay first-class packages, mirroring the Cargo.lock handling.
export function parsePoetryLockfile(file: ScannedFile): ParsedPoetryLockfile {
  const base = {
    manifestPath: poetryLockfileManifestPath(file.relativePath),
    lockfilePath: file.relativePath
  };
  const dependencies: PackageDependency[] = [];
  const blocks = file.content.split(/^\s*\[\[package\]\]\s*$/m).slice(1);
  for (const block of blocks) {
    const rawName = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    if (!rawName) continue;
    if (/^\s*type\s*=\s*"(?:directory|file)"/m.test(block)) continue;
    const name = normalizePythonPackageName(rawName);
    const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    dependencies.push({
      ecosystem: 'python',
      name,
      displayName: name,
      version,
      dependencyType: 'lockfile:transitive',
      confidence: 'proven',
      evidence: evidenceForNeedle(file.content, file.relativePath, `name = "${rawName}"`)
    });
  }
  return { ...base, dependencies: dedupeDependencies(dependencies), diagnostics: [] };
}
