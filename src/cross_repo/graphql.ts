export function firstMatchingGraphqlOperationLine(content: string, filePath: string, routePath: string): string | undefined {
  const target = parseGraphqlRoutePath(routePath);
  if (target === undefined) return undefined;
  const operationPattern = /\b(query|mutation|subscription)\b/g;
  let match: RegExpExecArray | null;
  while ((match = operationPattern.exec(content)) !== null) {
    if (lineStartsWithComment(content, match.index)) continue;
    if (isJsLikeGraphqlConsumerPath(filePath) && !isInsideBacktickTemplate(content, match.index)) continue;
    const operationType = graphqlRootTypeForOperation(match[1]!);
    if (operationType !== target.rootType) continue;
    const selectionStart = content.indexOf('{', operationPattern.lastIndex);
    if (selectionStart < 0) continue;
    const fieldOffset = graphqlRootSelectionFieldOffset(content, selectionStart, target.fieldName);
    if (fieldOffset !== undefined) return lineAtOffset(content, fieldOffset);
  }

  if (!isGraphqlDocumentPath(filePath)) return undefined;
  const anonymousSelectionStart = firstAnonymousGraphqlSelectionStart(content);
  if (target.rootType !== 'Query' || anonymousSelectionStart === undefined) return undefined;
  const anonymousFieldOffset = graphqlRootSelectionFieldOffset(content, anonymousSelectionStart, target.fieldName);
  return anonymousFieldOffset === undefined ? undefined : lineAtOffset(content, anonymousFieldOffset);
}

function parseGraphqlRoutePath(routePath: string): { rootType: 'Query' | 'Mutation' | 'Subscription'; fieldName: string } | undefined {
  const match = /^(Query|Mutation|Subscription)\.([_A-Za-z][_0-9A-Za-z]*)$/.exec(routePath);
  if (!match) return undefined;
  return {
    rootType: match[1] as 'Query' | 'Mutation' | 'Subscription',
    fieldName: match[2]!
  };
}

function isGraphqlDocumentPath(filePath: string): boolean {
  return /\.(?:graphql|gql)$/i.test(filePath);
}

function isJsLikeGraphqlConsumerPath(filePath: string): boolean {
  return /\.(?:tsx?|jsx?)$/i.test(filePath);
}

function graphqlRootTypeForOperation(operation: string): 'Query' | 'Mutation' | 'Subscription' {
  if (operation.toLowerCase() === 'mutation') return 'Mutation';
  if (operation.toLowerCase() === 'subscription') return 'Subscription';
  return 'Query';
}

function graphqlRootSelectionFieldOffset(
  content: string,
  selectionStart: number,
  targetFieldName: string
): number | undefined {
  let depth = 0;
  for (let index = selectionStart; index < content.length; index += 1) {
    const char = content[index];
    if (char === '"' || char === "'") {
      index = skipQuotedString(content, index);
      continue;
    }
    if (char === '#') {
      index = skipLine(content, index);
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth <= 0) return undefined;
      continue;
    }
    if (depth !== 1 || !isGraphqlNameStart(char)) continue;

    const parsed = parseGraphqlSelectionName(content, index);
    if (parsed === undefined) continue;
    if (parsed.fieldName === targetFieldName) return parsed.fieldOffset;
    index = parsed.nextOffset - 1;
  }
  return undefined;
}

function parseGraphqlSelectionName(
  content: string,
  offset: number
): { fieldName: string; fieldOffset: number; nextOffset: number } | undefined {
  const first = readGraphqlName(content, offset);
  if (first === undefined) return undefined;
  let nextOffset = skipWhitespace(content, first.end);
  if (content[nextOffset] !== ':') {
    return {
      fieldName: first.name,
      fieldOffset: first.start,
      nextOffset: first.end
    };
  }

  nextOffset = skipWhitespace(content, nextOffset + 1);
  const aliased = readGraphqlName(content, nextOffset);
  if (aliased === undefined) return undefined;
  return {
    fieldName: aliased.name,
    fieldOffset: aliased.start,
    nextOffset: aliased.end
  };
}

function readGraphqlName(content: string, offset: number): { name: string; start: number; end: number } | undefined {
  if (!isGraphqlNameStart(content[offset])) return undefined;
  let end = offset + 1;
  while (end < content.length && /[_0-9A-Za-z]/.test(content[end]!)) end += 1;
  return {
    name: content.slice(offset, end),
    start: offset,
    end
  };
}

function firstAnonymousGraphqlSelectionStart(content: string): number | undefined {
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char === '"' || char === "'") {
      index = skipQuotedString(content, index);
      continue;
    }
    if (char === '#') {
      index = skipLine(content, index);
      continue;
    }
    if (char === '{' && !lineStartsWithComment(content, index)) return index;
  }
  return undefined;
}

function lineAtOffset(content: string, offset: number): string {
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1;
  const lineEnd = content.indexOf('\n', offset);
  return content.slice(lineStart, lineEnd < 0 ? content.length : lineEnd).trim();
}

function skipWhitespace(content: string, offset: number): number {
  let index = offset;
  while (index < content.length && /\s/.test(content[index]!)) index += 1;
  return index;
}

function skipQuotedString(content: string, offset: number): number {
  const quote = content[offset];
  const tripleQuoted = quote === '"' && content.slice(offset, offset + 3) === '"""';
  if (tripleQuoted) {
    const end = content.indexOf('"""', offset + 3);
    return end < 0 ? content.length : end + 2;
  }
  let index = offset + 1;
  while (index < content.length) {
    if (content[index] === '\\') {
      index += 2;
      continue;
    }
    if (content[index] === quote) return index;
    index += 1;
  }
  return content.length;
}

function skipLine(content: string, offset: number): number {
  const lineEnd = content.indexOf('\n', offset);
  return lineEnd < 0 ? content.length : lineEnd;
}

function lineStartsWithComment(content: string, offset: number): boolean {
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1;
  return /^\s*(?:#|\/\/)/.test(content.slice(lineStart, offset));
}

function isInsideBacktickTemplate(content: string, offset: number): boolean {
  type ScannerState = 'code' | 'line_comment' | 'block_comment' | 'single_quote' | 'double_quote' | 'template';
  let state: ScannerState = 'code';
  for (let index = 0; index < offset; index += 1) {
    const char = content[index]!;
    const next = content[index + 1];
    if (state === 'line_comment') {
      if (char === '\n' || char === '\r') state = 'code';
      continue;
    }
    if (state === 'block_comment') {
      if (char === '*' && next === '/') {
        state = 'code';
        index += 1;
      }
      continue;
    }
    if (state === 'single_quote') {
      if (char === '\\') {
        index += 1;
      } else if (char === "'") {
        state = 'code';
      }
      continue;
    }
    if (state === 'double_quote') {
      if (char === '\\') {
        index += 1;
      } else if (char === '"') {
        state = 'code';
      }
      continue;
    }
    if (state === 'template') {
      if (char === '\\') {
        index += 1;
      } else if (char === '`') {
        state = 'code';
      }
      continue;
    }

    if (char === '/' && next === '/') {
      state = 'line_comment';
      index += 1;
    } else if (char === '/' && next === '*') {
      state = 'block_comment';
      index += 1;
    } else if (char === "'") {
      state = 'single_quote';
    } else if (char === '"') {
      state = 'double_quote';
    } else if (char === '`') {
      state = 'template';
    }
  }
  return state === 'template';
}

function isGraphqlNameStart(value: string | undefined): boolean {
  return value !== undefined && /[_A-Za-z]/.test(value);
}
