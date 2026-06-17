import path from 'node:path';

import { entityKindForMarkdownPath } from './artifacts.js';
import type { EntityKind } from './types.js';

const languageByExtension = new Map<string, string>([
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.md', 'markdown'],
  ['.py', 'python'],
  ['.go', 'go'],
  ['.rs', 'rust'],
  ['.java', 'java'],
  ['.kt', 'kotlin'],
  ['.kts', 'kotlin'],
  ['.cs', 'csharp'],
  ['.c', 'c'],
  ['.h', 'c'],
  ['.cpp', 'cpp'],
  ['.cc', 'cpp'],
  ['.cxx', 'cpp'],
  ['.hpp', 'cpp'],
  ['.hh', 'cpp'],
  ['.hxx', 'cpp'],
  ['.sh', 'shell'],
  ['.bash', 'shell'],
  ['.zsh', 'shell'],
  ['.yaml', 'yaml'],
  ['.yml', 'yaml'],
  ['.json', 'json'],
  ['.toml', 'toml'],
  ['.properties', 'properties'],
  ['.tf', 'terraform'],
  ['.proto', 'protobuf'],
  ['.graphql', 'graphql'],
  ['.gql', 'graphql'],
  ['.gradle', 'gradle']
]);

const languageByFileName = new Map<string, string>([
  ['Dockerfile', 'dockerfile'],
  ['Containerfile', 'dockerfile'],
  ['Makefile', 'makefile'],
  ['CODEOWNERS', 'policy'],
  ['package.json', 'json'],
  ['pnpm-workspace.yaml', 'yaml'],
  ['pom.xml', 'xml'],
  ['settings.gradle', 'gradle'],
  ['settings.gradle.kts', 'gradle'],
  ['build.gradle', 'gradle'],
  ['build.gradle.kts', 'gradle'],
  ['go.mod', 'go'],
  ['go.work', 'go'],
  ['Cargo.toml', 'toml'],
  ['pyproject.toml', 'toml']
]);

const configLanguageIds = new Set(['yaml', 'json', 'toml', 'properties', 'shell', 'makefile', 'gradle', 'xml']);

export function languageIdForPath(relativePath: string): string | undefined {
  const basename = path.posix.basename(relativePath);
  const byName = languageByFileName.get(basename);
  if (byName) return byName;
  const ext = path.posix.extname(basename).toLowerCase();
  return languageByExtension.get(ext);
}

export function isTestPath(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath);
  return (
    /(^|\/)(tests?|__tests__)\/|(^|\/)src\/test\//.test(relativePath) ||
    /(\.|-)(test|spec)\.[cm]?[tj]sx?$/.test(basename) ||
    /(?:Test|Tests|Spec)\.(?:java|kt)$/.test(basename) ||
    /(?:^test_.*|.*_test)\.py$/.test(basename) ||
    /_test\.go$/.test(basename) ||
    /(?:_test|_spec)\.rs$/.test(basename)
  );
}

export function isBuildManifestPath(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath);
  return (
    basename === 'package.json' ||
    basename === 'pnpm-workspace.yaml' ||
    basename === 'pom.xml' ||
    basename === 'settings.gradle' ||
    basename === 'settings.gradle.kts' ||
    basename === 'build.gradle' ||
    basename === 'build.gradle.kts' ||
    basename === 'go.mod' ||
    basename === 'go.work' ||
    basename === 'Cargo.toml' ||
    basename === 'pyproject.toml'
  );
}

export function isObviousContractPath(relativePath: string): boolean {
  const basename = path.posix.basename(relativePath);
  const withoutExtension = basename.replace(/\.[^.]+$/, '').toLowerCase();
  return (
    withoutExtension.includes('openapi') ||
    withoutExtension.includes('swagger') ||
    withoutExtension.includes('asyncapi')
  );
}

export function entityKindForPath(relativePath: string, languageId = languageIdForPath(relativePath)): EntityKind {
  if (isTestPath(relativePath)) return 'test';
  if (languageId === 'markdown') return entityKindForMarkdownPath(relativePath);
  if (languageId === 'policy') return 'policy';
  if (languageId === 'yaml' && relativePath.startsWith('.github/workflows/')) return 'workflow';
  if ((languageId === 'yaml' || languageId === 'json') && isObviousContractPath(relativePath)) return 'contract';
  if (languageId === 'dockerfile' || languageId === 'terraform') return 'resource';
  if (isBuildManifestPath(relativePath)) return 'config';
  if (languageId === 'protobuf' || languageId === 'graphql') return 'contract';
  if (languageId !== undefined && configLanguageIds.has(languageId)) return 'config';
  return 'file';
}
