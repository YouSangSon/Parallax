import type { ConsumerEvidence } from './types.js';
import {
  escapeRegExp,
  firstRegexMatch,
  sourceLinesWithCommentMasks,
  stringLiteralAssignmentAliasPatterns,
  uniqueNamedAliases
} from './shared.js';

export function firstMatchingHttpEvidence(
  content: string,
  _filePath: string,
  httpMethod: string,
  routePath: string
): ConsumerEvidence | undefined {
  const lines = sourceLinesWithCommentMasks(content);
  const aliases = httpRouteAliases(lines, routePath);
  const aliasDeclarationLineIndexes = new Set(aliases.map((alias) => alias.declarationLineIndex));
  const feignMappingLineIndexes = springFeignMappingLineIndexes(lines);

  for (const [lineIndex, candidate] of lines.entries()) {
    if (!containsHttpRouteLiteral(candidate.masked, routePath)) continue;
    if (aliasDeclarationLineIndexes.has(lineIndex)) continue;
    if (isHttpRouteSourceDeclaration(candidate.masked, routePath)) continue;
    if (!httpConsumerLineMatches(candidate.masked, httpMethod, feignMappingLineIndexes.has(lineIndex))) continue;
    return { snippet: candidate.raw.trim() };
  }

  for (const alias of aliases) {
    for (const [lineIndex, candidate] of lines.entries()) {
      if (lineIndex === alias.declarationLineIndex) continue;
      if (!containsDirectHttpAliasReference(candidate.masked, alias.name)) continue;
      if (!httpConsumerLineMatches(candidate.masked, httpMethod, feignMappingLineIndexes.has(lineIndex))) continue;
      return { snippet: candidate.raw.trim() };
    }
  }

  return undefined;
}

function httpRouteAliases(
  lines: Array<{ masked: string }>,
  routePath: string
): Array<{ name: string; declarationLineIndex: number }> {
  const aliases: Array<{ name: string; declarationLineIndex: number }> = [];
  const assignmentPatterns = stringLiteralAssignmentAliasPatterns(routePath);

  for (const [lineIndex, line] of lines.entries()) {
    if (isHttpConsumerCallSyntax(line.masked)) continue;
    const assignment = firstRegexMatch(assignmentPatterns, line.masked);
    if (assignment?.[1] !== undefined) {
      aliases.push({ name: assignment[1], declarationLineIndex: lineIndex });
    }
  }

  return uniqueNamedAliases(aliases);
}

function containsHttpRouteLiteral(value: string, routePath: string): boolean {
  const escaped = escapeRegExp(routePath);
  const quotedPath = new RegExp('["\'`](?:https?:\\/\\/[^"\'`\\s)]*)?' + escaped + '(?:[?#][^"\'`]*)?["\'`]');
  return quotedPath.test(value);
}

function isHttpRouteSourceDeclaration(line: string, routePath: string): boolean {
  if (isHttpConsumerCallSyntax(line)) return false;
  return stringLiteralAssignmentAliasPatterns(routePath).some((pattern) => pattern.test(line));
}

function containsDirectHttpAliasReference(value: string, aliasName: string): boolean {
  const escaped = escapeRegExp(aliasName);
  const directReferencePattern = new RegExp(
    `(?:^|[(:,=\\[]|\\b(?:url|uri|path|value)\\s*[:=])\\s*${escaped}\\s*(?:$|[,)}\\];])`
  );
  return directReferencePattern.test(value);
}

function httpConsumerLineMatches(line: string, method: string, isFeignMappingLine: boolean): boolean {
  return springHttpMappingLineMatches(line, method, isFeignMappingLine) ||
    fetchLineMatches(line, method) ||
    springHttpClientLineMatches(line, method) ||
    genericHttpClientLineMatches(line, method);
}

function springHttpMappingLineMatches(line: string, method: string, isFeignMappingLine: boolean): boolean {
  const normalized = method.toUpperCase();
  const annotationName = springMappingAnnotationForHttpMethod(normalized);
  if (annotationName !== undefined) {
    const mappingPattern = new RegExp(`@(?:[A-Za-z_][\\w.]*\\.)?${annotationName}\\b`);
    if (mappingPattern.test(line)) return isFeignMappingLine;
  }
  if (/@(?:[A-Za-z_][\w.]*\.)?RequestMapping\b/.test(line)) {
    return isFeignMappingLine && methodMatches(line, normalized);
  }
  const requestLinePattern = new RegExp(`@(?:[A-Za-z_][\\w.]*\\.)?RequestLine\\s*\\(\\s*["'\`]${escapeRegExp(normalized)}\\b`, 'i');
  return requestLinePattern.test(line);
}

function springFeignMappingLineIndexes(lines: Array<{ masked: string }>): Set<number> {
  const indexes = new Set<number>();
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (!/@(?:[A-Za-z_][\w.]*\.)?FeignClient\b/.test(lines[lineIndex]!.masked)) continue;
    const declarationIndex = firstClassDeclarationLineIndex(lines, lineIndex + 1);
    if (declarationIndex === undefined) continue;
    let depth = 0;
    let enteredBody = false;
    for (let bodyLineIndex = declarationIndex; bodyLineIndex < lines.length; bodyLineIndex += 1) {
      const line = lines[bodyLineIndex]!.masked;
      if (bodyLineIndex > declarationIndex && enteredBody && springMappingAnnotationLineMatches(line)) {
        indexes.add(bodyLineIndex);
      }
      const delta = braceDeltaOutsideStrings(line);
      if (delta !== 0) {
        depth += delta;
        enteredBody = enteredBody || depth > 0;
      }
      if (enteredBody && depth <= 0) break;
    }
  }
  return indexes;
}

function firstClassDeclarationLineIndex(
  lines: Array<{ masked: string }>,
  startIndex: number
): number | undefined {
  for (let lineIndex = startIndex; lineIndex < Math.min(lines.length, startIndex + 8); lineIndex += 1) {
    if (/\b(?:class|interface|record)\s+[_$A-Za-z][_$0-9A-Za-z]*\b/.test(lines[lineIndex]!.masked)) {
      return lineIndex;
    }
  }
  return undefined;
}

function springMappingAnnotationLineMatches(line: string): boolean {
  return /@(?:[A-Za-z_][\w.]*\.)?(?:Get|Post|Put|Patch|Delete|Request)Mapping\b/.test(line);
}

function braceDeltaOutsideStrings(line: string): number {
  let delta = 0;
  let state: 'code' | 'single' | 'double' | 'template' = 'code';
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (state === 'single') {
      if (char === '\\') index += 1;
      else if (char === "'") state = 'code';
      continue;
    }
    if (state === 'double') {
      if (char === '\\') index += 1;
      else if (char === '"') state = 'code';
      continue;
    }
    if (state === 'template') {
      if (char === '\\') index += 1;
      else if (char === '`') state = 'code';
      continue;
    }
    if (char === "'") {
      state = 'single';
    } else if (char === '"') {
      state = 'double';
    } else if (char === '`') {
      state = 'template';
    } else if (char === '{') {
      delta += 1;
    } else if (char === '}') {
      delta -= 1;
    }
  }
  return delta;
}

function springMappingAnnotationForHttpMethod(method: string): string | undefined {
  if (method === 'GET') return 'GetMapping';
  if (method === 'POST') return 'PostMapping';
  if (method === 'PUT') return 'PutMapping';
  if (method === 'PATCH') return 'PatchMapping';
  if (method === 'DELETE') return 'DeleteMapping';
  return undefined;
}

function fetchLineMatches(line: string, method: string): boolean {
  if (!/\bfetch\s*\(/i.test(line)) return false;
  if (method.toUpperCase() === 'GET' && !/\bmethod\s*[:=]/i.test(line)) return true;
  return methodMatches(line, method);
}

function springHttpClientLineMatches(line: string, method: string): boolean {
  const normalized = method.toUpperCase();
  const lower = normalized.toLowerCase();
  const fluentMethodPattern = new RegExp(
    `\\b(?:webClient|WebClient|restClient|RestClient|httpClient|HttpClient)\\b[\\s\\S]*\\.\\s*${escapeRegExp(lower)}\\s*\\(`,
    'i'
  );
  if (fluentMethodPattern.test(line)) return true;

  const restTemplatePatterns = restTemplateMethodPatterns(normalized);
  if (restTemplatePatterns.some((pattern) => pattern.test(line))) return true;

  const httpMethodPattern = new RegExp(`\\bHttpMethod\\s*\\.\\s*${escapeRegExp(normalized)}\\b`, 'i');
  return httpMethodPattern.test(line);
}

function restTemplateMethodPatterns(method: string): RegExp[] {
  const receiver = String.raw`\b(?:restTemplate|RestTemplate)\b[\s\S]*\.\s*`;
  if (method === 'GET') return [new RegExp(`${receiver}getFor(?:Object|Entity)\\s*\\(`, 'i')];
  if (method === 'POST') return [new RegExp(`${receiver}postFor(?:Object|Entity|Location)\\s*\\(`, 'i')];
  if (method === 'PUT') return [new RegExp(`${receiver}put\\s*\\(`, 'i')];
  if (method === 'PATCH') return [new RegExp(`${receiver}patchForObject\\s*\\(`, 'i')];
  if (method === 'DELETE') return [new RegExp(`${receiver}delete\\s*\\(`, 'i')];
  return [];
}

function genericHttpClientLineMatches(line: string, method: string): boolean {
  const normalized = method.toLowerCase();
  const methodCallPattern = new RegExp(`\\b(?:axios|ky|got|superagent|httpClient)\\s*\\.\\s*${escapeRegExp(normalized)}\\s*\\(`, 'i');
  return methodCallPattern.test(line);
}

function isHttpConsumerCallSyntax(line: string): boolean {
  return /\bfetch\s*\(|@(?:[A-Za-z_][\w.]*\.)?(?:Get|Post|Put|Patch|Delete|Request)Mapping\b|@(?:[A-Za-z_][\w.]*\.)?RequestLine\b|\bHttpMethod\s*\./i.test(line) ||
    /\b(?:axios|ky|superagent|request|client|httpClient|webClient|restTemplate)\s*\./i.test(line);
}

function methodMatches(line: string, method: string): boolean {
  if (method === 'GET' && !/\bmethod\s*[:=]/i.test(line)) return true;
  const methodPattern = new RegExp(`\\b${escapeRegExp(method)}\\b`, 'i');
  return methodPattern.test(line);
}
