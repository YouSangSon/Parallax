export function isDocumentationPath(filePath: string): boolean {
  return /^(?:docs?|examples?|samples?)\//i.test(filePath) || /(?:^|\/)README(?:\.[^.]+)?$/i.test(filePath);
}

export function isSourceFilePath(filePath: string): boolean {
  return /\.(?:tsx?|jsx?|java|kt|kts|py|go|rs|cs)$/i.test(filePath);
}

export function isSourceOrConfigFilePath(filePath: string): boolean {
  return isSourceFilePath(filePath) || /\.(?:ya?ml|json|toml|properties)$/i.test(filePath);
}

export function isGeneratedProtobufFilePath(filePath: string): boolean {
  return /(?:^|\/)(?:gen|generated|__generated__)\//i.test(filePath) ||
    /(?:_pb|_grpc_pb|_connect|_connectweb|_pb2|_pb2_grpc)\.[^.]+$/i.test(filePath);
}

export function sourceLinesWithCommentMasks(content: string): Array<{ raw: string; masked: string }> {
  const lines: Array<{ raw: string; masked: string }> = [];
  const rawLines = content.split(/\r?\n/);
  let inBlockComment = false;
  for (const raw of rawLines) {
    let masked = '';
    let state: 'code' | 'single' | 'double' | 'template' = 'code';
    for (let index = 0; index < raw.length; index += 1) {
      const char = raw[index]!;
      const next = raw[index + 1];

      if (inBlockComment) {
        if (char === '*' && next === '/') {
          masked += '  ';
          inBlockComment = false;
          index += 1;
        } else {
          masked += char === '\t' ? '\t' : ' ';
        }
        continue;
      }

      if (state === 'single') {
        masked += char;
        if (char === '\\') {
          if (next !== undefined) {
            masked += next;
            index += 1;
          }
        } else if (char === "'") {
          state = 'code';
        }
        continue;
      }

      if (state === 'double') {
        masked += char;
        if (char === '\\') {
          if (next !== undefined) {
            masked += next;
            index += 1;
          }
        } else if (char === '"') {
          state = 'code';
        }
        continue;
      }

      if (state === 'template') {
        masked += char;
        if (char === '\\') {
          if (next !== undefined) {
            masked += next;
            index += 1;
          }
        } else if (char === '`') {
          state = 'code';
        }
        continue;
      }

      if (char === '/' && next === '/') {
        masked += ' '.repeat(raw.length - index);
        break;
      }
      if (char === '/' && next === '*') {
        masked += '  ';
        inBlockComment = true;
        index += 1;
        continue;
      }
      if (char === '#') {
        masked += ' '.repeat(raw.length - index);
        break;
      }
      if (char === "'") state = 'single';
      if (char === '"') state = 'double';
      if (char === '`') state = 'template';
      masked += char;
    }
    lines.push({ raw, masked });
  }
  return lines;
}

export function stringLiteralAssignmentAliasPatterns(literal: string): RegExp[] {
  const quotedLiteral = escapeRegExp(literal);
  return [
    `^\\s*(?:export\\s+)?(?:(?:const|let|var)\\s+)?([_$A-Za-z][_$0-9A-Za-z]*)\\s*(?::\\s*[^=]+)?=\\s*(["'\`])${quotedLiteral}\\2\\s*(?:[;,}]|$)`,
    `^\\s*(?:(?:private|public|protected|internal)\\s+)*(?:const\\s+)?val\\s+([_$A-Za-z][_$0-9A-Za-z]*)\\s*(?::\\s*[^=]+)?=\\s*(["'\`])${quotedLiteral}\\2\\s*(?:[;,}]|$)`,
    `^\\s*(?:(?:private|public|protected|static|final)\\s+)*(?:String|java\\.lang\\.String)\\s+([_$A-Za-z][_$0-9A-Za-z]*)\\s*=\\s*(["'\`])${quotedLiteral}\\2\\s*;?\\s*$`
  ].map((pattern) => new RegExp(pattern));
}

export function firstRegexMatch(patterns: RegExp[], value: string): RegExpExecArray | null {
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match) return match;
  }
  return null;
}

export function uniqueNamedAliases(
  aliases: Array<{ name: string; declarationLineIndex: number }>
): Array<{ name: string; declarationLineIndex: number }> {
  const seen = new Set<string>();
  const unique: Array<{ name: string; declarationLineIndex: number }> = [];
  for (const alias of aliases) {
    const key = `${alias.name}:${alias.declarationLineIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(alias);
  }
  return unique;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
