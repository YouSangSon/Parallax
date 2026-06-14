import type { ConsumerEvidence, CrossRepoEventTopology } from './types.js';
import {
  escapeRegExp,
  firstRegexMatch,
  isSourceFilePath,
  sourceLinesWithCommentMasks,
  stringLiteralAssignmentAliasPatterns,
  uniqueNamedAliases
} from './shared.js';

export function firstMatchingAsyncApiEventEvidence(
  content: string,
  filePath: string,
  providerAction: string,
  routePath: string
): ConsumerEvidence | undefined {
  const lines = sourceLinesWithCommentMasks(content);
  const aliases = asyncApiEventAddressAliases(lines, routePath);
  const aliasDeclarationLineIndexes = new Set(aliases.map((alias) => alias.declarationLineIndex));
  const allowBareRouteToken = !isSourceFilePath(filePath);
  for (const [lineIndex, candidate] of lines.entries()) {
    if (!containsAsyncApiRouteLiteral(candidate.masked, routePath, allowBareRouteToken)) continue;
    if (aliasDeclarationLineIndexes.has(lineIndex)) continue;
    if (isSourceFilePath(filePath) && isAsyncApiEventAddressSourceDeclaration(candidate.masked, routePath)) continue;
    const snippet = candidate.raw.trim();
    const topology = classifyAsyncApiEventLine(candidate.masked.trim(), providerAction);
    if (topology.counterpartyRole === 'unknown') {
      continue;
    }
    if (asyncApiCounterpartyRoleMatchesProviderAction(providerAction, topology.counterpartyRole)) {
      return { snippet, eventTopology: topology };
    }
  }
  for (const alias of aliases) {
    for (const [lineIndex, candidate] of lines.entries()) {
      if (lineIndex === alias.declarationLineIndex) continue;
      if (!containsDirectAsyncApiAliasReference(candidate.masked, alias.name)) continue;
      const snippet = candidate.raw.trim();
      const topology = classifyAsyncApiEventLine(candidate.masked.trim(), providerAction);
      if (topology.counterpartyRole === 'unknown') {
        continue;
      }
      if (asyncApiCounterpartyRoleMatchesProviderAction(providerAction, topology.counterpartyRole)) {
        return { snippet, eventTopology: topology };
      }
    }
  }
  return undefined;
}

function asyncApiEventAddressAliases(
  lines: Array<{ masked: string }>,
  routePath: string
): Array<{ name: string; declarationLineIndex: number }> {
  const aliases: Array<{ name: string; declarationLineIndex: number }> = [];
  const assignmentPatterns = stringLiteralAssignmentAliasPatterns(routePath);

  for (const [lineIndex, line] of lines.entries()) {
    if (isAsyncApiEventCallSyntax(line.masked)) continue;
    const assignment = firstRegexMatch(assignmentPatterns, line.masked);
    if (assignment?.[1] !== undefined) {
      aliases.push({ name: assignment[1], declarationLineIndex: lineIndex });
    }
  }

  return uniqueNamedAliases(aliases);
}

function isAsyncApiEventCallSyntax(line: string): boolean {
  return /@\w+\s*\(|\b[_$A-Za-z][_$0-9A-Za-z]*(?:\s*\.\s*[_$A-Za-z][_$0-9A-Za-z]*)?\s*\(/.test(line);
}

function isAsyncApiEventAddressSourceDeclaration(line: string, routePath: string): boolean {
  if (isAsyncApiEventCallSyntax(line)) return false;
  const quotedRoutePath = escapeRegExp(routePath);
  const pattern = new RegExp(
    `^\\s*(?:export\\s+)?(?:(?:const|let|var)\\s+)?[_$A-Za-z][_$0-9A-Za-z]*(?:\\s*\\.\\s*[_$A-Za-z][_$0-9A-Za-z]*)*[\\s\\S]*=\\s*[\\s\\S]*(["'\`])${quotedRoutePath}\\1`
  );
  return pattern.test(line);
}

function classifyAsyncApiEventLine(line: string, providerAction: string): CrossRepoEventTopology {
  const lowered = line.toLowerCase();
  const consumerPatterns: Array<[RegExp, string]> = [
    [/@kafkalistener\b/i, 'spring-kafka-listener'],
    [/\bconsumer\s*\.\s*subscribe\b/i, 'kafkajs-consumer-subscribe'],
    [/\bsubscribe(?:to)?\s*\(/i, 'subscriber-call'],
    [/\blisten(?:er)?\s*\(/i, 'listener-call'],
    [/\bonmessage\b|\bhandler\s*[:=]/i, 'message-handler'],
    [/\baiokafkaconsumer\b|\bkafkaconsumer\b/i, 'python-kafka-consumer'],
    [/\breaderconfig\b|\bnewreader\b/i, 'go-kafka-reader'],
    [/\bstreamconsumer\b|\bbaseconsumer\b|\bsubscribe\s*\(/i, 'rust-kafka-consumer'],
    [/\bconsumer\b.*(?:topic|topics|channel|queue)/i, 'consumer-config']
  ];
  const producerPatterns: Array<[RegExp, string]> = [
    [/\bkafkatemplate\s*\.\s*send\b/i, 'spring-kafka-template-send'],
    [/\bproducer\s*\.\s*send\b/i, 'producer-send'],
    [/\bsend_and_wait\s*\(/i, 'python-aiokafka-send'],
    [/\bpublish\s*\(/i, 'publisher-call'],
    [/\bemit\s*\(/i, 'emitter-call'],
    [/\bwriterconfig\b|\bnewwriter\b/i, 'go-kafka-writer'],
    [/\bfutureproducer\b|\bbaseproducer\b/i, 'rust-kafka-producer'],
    [/\bproducer\b.*(?:topic|topics|channel|queue)/i, 'producer-config']
  ];

  for (const [pattern, name] of consumerPatterns) {
    if (pattern.test(line)) {
      return { providerAction, counterpartyRole: 'consumer', pattern: name };
    }
  }
  for (const [pattern, name] of producerPatterns) {
    if (pattern.test(line)) {
      return { providerAction, counterpartyRole: 'producer', pattern: name };
    }
  }

  if (/\b(?:subscribe|listener|consumer|reader)\b/.test(lowered)) {
    return { providerAction, counterpartyRole: 'consumer', pattern: 'consumer-keyword' };
  }
  if (/\b(?:publish|producer|send|emit|writer)\b/.test(lowered)) {
    return { providerAction, counterpartyRole: 'producer', pattern: 'producer-keyword' };
  }
  return { providerAction, counterpartyRole: 'unknown', pattern: 'exact-event-address' };
}

function asyncApiCounterpartyRoleMatchesProviderAction(
  providerAction: string,
  counterpartyRole: CrossRepoEventTopology['counterpartyRole']
): boolean {
  const action = providerAction.toUpperCase();
  if (counterpartyRole === 'consumer') return action === 'SEND' || action === 'PUBLISH';
  if (counterpartyRole === 'producer') return action === 'RECEIVE' || action === 'SUBSCRIBE';
  return true;
}

function containsDelimitedToken(value: string, token: string): boolean {
  let offset = 0;
  while (offset < value.length) {
    const index = value.indexOf(token, offset);
    if (index < 0) return false;
    const before = index === 0 ? undefined : value[index - 1];
    const after = index + token.length >= value.length ? undefined : value[index + token.length];
    if (!isRouteTokenChar(before) && !isRouteTokenChar(after)) return true;
    offset = index + token.length;
  }
  return false;
}

function containsAsyncApiRouteLiteral(value: string, routePath: string, allowBareRouteToken: boolean): boolean {
  let offset = 0;
  while (offset < value.length) {
    const index = value.indexOf(routePath, offset);
    if (index < 0) return false;
    const before = index === 0 ? undefined : value[index - 1];
    const after = index + routePath.length >= value.length ? undefined : value[index + routePath.length];
    const beforeLiteralQuote = before === '"' || before === "'" || before === '`';
    const matchingLiteralQuote = beforeLiteralQuote && after === before;
    if (matchingLiteralQuote &&
      !hasComputedLiteralHead(value.slice(0, index - 1)) &&
      !hasComputedLiteralTail(value.slice(index + routePath.length + 1))) {
      return true;
    }
    if (allowBareRouteToken && !beforeLiteralQuote && after !== '"' && after !== "'" && after !== '`' &&
      !isRouteTokenChar(before) && !isRouteTokenChar(after)) {
      return true;
    }
    offset = index + routePath.length;
  }
  return false;
}

function hasComputedLiteralHead(valueBeforeOpeningQuote: string): boolean {
  const boundaryIndex = Math.max(
    valueBeforeOpeningQuote.lastIndexOf('('),
    valueBeforeOpeningQuote.lastIndexOf('{'),
    valueBeforeOpeningQuote.lastIndexOf('['),
    valueBeforeOpeningQuote.lastIndexOf(','),
    valueBeforeOpeningQuote.lastIndexOf('='),
    valueBeforeOpeningQuote.lastIndexOf(':')
  );
  return valueBeforeOpeningQuote.slice(boundaryIndex + 1).trim().length > 0;
}

function hasComputedLiteralTail(valueAfterClosingQuote: string): boolean {
  for (let index = 0; index < valueAfterClosingQuote.length; index += 1) {
    const char = valueAfterClosingQuote[index]!;
    if (/\s/.test(char) || char === ')' || char === ']') continue;
    if (char === '+' || char === '.' || valueAfterClosingQuote.startsWith('??', index) ||
      valueAfterClosingQuote.startsWith('||', index) || valueAfterClosingQuote.startsWith('&&', index)) {
      return true;
    }
    if (char === ',' || char === ';' || char === '}') return false;
  }
  return false;
}

function containsIdentifierToken(value: string, token: string): boolean {
  const pattern = new RegExp(`(?<![_$0-9A-Za-z])${escapeRegExp(token)}(?![_$0-9A-Za-z])`);
  return pattern.test(value);
}

function containsDirectAsyncApiAliasReference(value: string, token: string): boolean {
  if (!containsIdentifierToken(value, token)) return false;
  const escaped = escapeRegExp(token);
  if (new RegExp(`\\$\\{\\s*${escaped}\\s*\\}`).test(value)) return false;
  const directReferencePattern = new RegExp(
    `(?:^|[(:,=\\[]|\\b(?:topic|topics|channel|queue)\\s*[:=])\\s*${escaped}\\s*(?:$|[,)}\\];])`
  );
  return directReferencePattern.test(value);
}

function isRouteTokenChar(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_.:/-]/.test(value);
}
