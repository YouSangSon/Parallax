import path from 'node:path';

import type { ScannedFile } from '../../types.js';
import type { PendingEvidence } from '../types.js';
import { buildManifestKind, dedupeDependencies, evidenceLineAt, localPackage, packageKey } from './shared.js';
import type {
  LocalPackage,
  PackageDependency,
  PackageIndex,
  ParsedManifest,
  ScopedPackageIndex
} from './types.js';

type GoLocalReplaceAlias = {
  modulePath: string;
  targetManifestPath: string;
};

type GoPathDirective = {
  value: string;
  offset: number;
};

export function goModSyntaxDiagnostics(file: ScannedFile): string[] {
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

export function parseGoMod(file: ScannedFile): ParsedManifest {
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

export function discoverGoLocalReplacementIndex(
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

export function goWorkUseTargets(
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
