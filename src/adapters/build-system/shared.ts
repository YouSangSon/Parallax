import path from 'node:path';

import type { ScannedFile } from '../../types.js';
import type { PendingEvidence } from '../types.js';
import type {
  BuildManifestKind,
  LocalPackage,
  PackageDependency,
  PackageEcosystem,
  TomlSectionBlock,
  TomlStringArrayAssignment,
  TomlStringValue
} from './types.js';

export function buildManifestKind(relativePath: string): BuildManifestKind | undefined {
  const basename = path.posix.basename(relativePath);
  if (basename === 'package.json') return 'npm';
  if (basename === 'package-lock.json') return 'npm-lock';
  if (basename === 'pom.xml') return 'maven';
  if (basename === 'settings.gradle' || basename === 'settings.gradle.kts') return 'gradle-settings';
  if (basename === 'build.gradle' || basename === 'build.gradle.kts') return 'gradle';
  if (basename === 'libs.versions.toml') return 'gradle-version-catalog';
  if (basename === 'go.mod') return 'go';
  if (basename === 'go.work') return 'go-work';
  if (basename === 'Cargo.toml') return 'cargo';
  if (basename === 'Cargo.lock') return 'cargo-lock';
  if (basename === 'pyproject.toml') return 'python';
  if (basename === 'poetry.lock') return 'poetry-lock';
  if (basename === 'pnpm-workspace.yaml') return 'pnpm-workspace';
  return undefined;
}

export function tomlSyntaxDiagnostics(file: ScannedFile, manifestName: 'Cargo.toml' | 'pyproject.toml'): string[] {
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

export function maskCommentsAndStrings(content: string): string {
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

export function matchingDelimiterIndex(
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

export function stripTomlComment(line: string): string {
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

export function tomlInlineString(value: string): string | undefined {
  return /^\s*"([^"]+)"/.exec(value)?.[1];
}

export function localPackage(
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

export function evidenceForNeedle(content: string, filePath: string, needle: string): PendingEvidence {
  const index = content.indexOf(needle);
  return evidenceLineAt(content, filePath, index < 0 ? 0 : index);
}

export function evidenceLineAt(content: string, filePath: string, offset: number): PendingEvidence {
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

export function offsetPosition(content: string, index: number): { line: number; col: number } {
  const prefix = content.slice(0, Math.max(0, index));
  const lines = prefix.split(/\r?\n/);
  return {
    line: lines.length,
    col: (lines.at(-1)?.length ?? 0) + 1
  };
}

export function packageKey(ecosystem: PackageEcosystem, name: string): string {
  const normalized = ecosystem === 'python' ? normalizePythonPackageName(name) : name;
  return `${ecosystem}:${normalized}`;
}

export function tomlStringInSection(content: string, sectionName: string, key: string): string | undefined {
  const section = tomlSection(content, sectionName);
  if (!section) return undefined;
  const match = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]+)"`, 'm').exec(section);
  return match?.[1];
}

export function tomlSection(content: string, sectionName: string): string | undefined {
  return tomlSectionBlock(content, sectionName)?.text;
}

export function tomlSectionBlock(content: string, sectionName: string): TomlSectionBlock | undefined {
  return tomlSections(content).find((section) => section.name === sectionName);
}

export function tomlSectionsMatching(content: string, pattern: RegExp): TomlSectionBlock[] {
  return tomlSections(content).filter((section) => pattern.test(section.name));
}

export function tomlSections(content: string): TomlSectionBlock[] {
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

export function tomlStringArrayAssignments(section: TomlSectionBlock): TomlStringArrayAssignment[] {
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

export function tomlArrayStringValues(arrayText: string, arrayOffset: number): TomlStringValue[] {
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

export function tomlInlineStringField(value: string, key: string): string | undefined {
  const match = new RegExp(`(?:^|[,{\\s])${escapeRegExp(key)}\\s*=\\s*"([^"]+)"`).exec(value);
  return match?.[1];
}

export function pythonDependencyName(specifier: string): string | undefined {
  const match = /^([A-Za-z0-9_.-]+)/.exec(specifier.trim());
  return match?.[1];
}

export function normalizePythonPackageName(name: string): string {
  return name.replace(/[-_.]+/g, '-').toLowerCase();
}

export function dedupeDependencies(dependencies: readonly PackageDependency[]): PackageDependency[] {
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

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hasOddUnescapedDoubleQuotes(line: string): boolean {
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

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
