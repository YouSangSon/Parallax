export const PROTOBUF_COMPAT_ANALYZER_ID = 'protobuf-compat-v0';
export const PROTOBUF_COMPAT_SCHEMA_VERSION = 1;

export type ProtobufCompatibilitySignature = {
  readonly schemaVersion: typeof PROTOBUF_COMPAT_SCHEMA_VERSION;
  readonly analyzer: typeof PROTOBUF_COMPAT_ANALYZER_ID;
  readonly contractKind: 'protobuf';
  readonly package?: string;
  readonly operations: readonly ProtobufOperationSignature[];
  readonly messages: readonly ProtobufMessageSignature[];
};

export type ProtobufOperationSignature = {
  readonly service: string;
  readonly rpc: string;
  readonly path: string;
  readonly requestType: string;
  readonly responseType: string;
  readonly requestStream: boolean;
  readonly responseStream: boolean;
};

export type ProtobufMessageSignature = {
  readonly name: string;
  readonly fields: readonly ProtobufFieldSignature[];
};

export type ProtobufFieldSignature = {
  readonly number: number;
  readonly name: string;
  readonly type: string;
  readonly label: 'singular' | 'optional' | 'required' | 'repeated';
};

type Block = {
  name: string;
  body: string;
};

const PROTOBUF_SCALAR_TYPES = new Set([
  'double',
  'float',
  'int32',
  'int64',
  'uint32',
  'uint64',
  'sint32',
  'sint64',
  'fixed32',
  'fixed64',
  'sfixed32',
  'sfixed64',
  'bool',
  'string',
  'bytes'
]);

export function extractProtobufCompatibility(content: string): ProtobufCompatibilitySignature | undefined {
  const stripped = stripProtobufComments(content);
  const packageName = packageNameFor(stripped);
  const operations = serviceBlocks(stripped).flatMap((service) => rpcSignatures(service.body, service.name, packageName));
  const messages = messageBlocks(stripped).map((message) => ({
    name: qualifyTypeName(message.name, packageName),
    fields: fieldSignatures(message.body, packageName)
  }));
  if (operations.length === 0 && messages.length === 0) return undefined;
  return {
    schemaVersion: PROTOBUF_COMPAT_SCHEMA_VERSION,
    analyzer: PROTOBUF_COMPAT_ANALYZER_ID,
    contractKind: 'protobuf',
    ...(packageName !== undefined ? { package: packageName } : {}),
    operations: operations.sort(compareOperations),
    messages: messages.sort((left, right) => left.name.localeCompare(right.name))
  };
}

function packageNameFor(content: string): string | undefined {
  const match = /^\s*package\s+([A-Za-z_][\w.]*)\s*;/m.exec(content);
  return match?.[1];
}

function serviceBlocks(content: string): Block[] {
  return namedBlocks(content, /\bservice\s+([A-Za-z_]\w*)\s*\{/g);
}

function messageBlocks(content: string): Block[] {
  return namedBlocks(content, /\bmessage\s+([A-Za-z_]\w*)\s*\{/g);
}

function namedBlocks(content: string, pattern: RegExp): Block[] {
  const blocks: Block[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    const openBraceIndex = content.indexOf('{', match.index);
    if (openBraceIndex === -1) continue;
    const closeBraceIndex = matchingBraceIndex(content, openBraceIndex);
    if (closeBraceIndex === -1) continue;
    blocks.push({
      name: match[1]!,
      body: content.slice(openBraceIndex + 1, closeBraceIndex)
    });
    pattern.lastIndex = closeBraceIndex + 1;
  }
  return blocks;
}

function matchingBraceIndex(content: string, openBraceIndex: number): number {
  let depth = 0;
  for (let index = openBraceIndex; index < content.length; index += 1) {
    const char = content[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function rpcSignatures(body: string, serviceName: string, packageName: string | undefined): ProtobufOperationSignature[] {
  const operations: ProtobufOperationSignature[] = [];
  const pattern =
    /\brpc\s+([A-Za-z_]\w*)\s*\(\s*(stream\s+)?([A-Za-z_][.\w]*)\s*\)\s*returns\s*\(\s*(stream\s+)?([A-Za-z_][.\w]*)\s*\)\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    const rpc = match[1]!;
    operations.push({
      service: serviceName,
      rpc,
      path: `${serviceName}/${rpc}`,
      requestType: qualifyTypeName(match[3]!, packageName),
      responseType: qualifyTypeName(match[5]!, packageName),
      requestStream: match[2] !== undefined,
      responseStream: match[4] !== undefined
    });
  }
  return operations;
}

function fieldSignatures(body: string, packageName: string | undefined): ProtobufFieldSignature[] {
  const fields: ProtobufFieldSignature[] = [];
  const topLevelBody = stripNestedProtobufBlocks(body);
  const pattern =
    /^\s*(?:(optional|required|repeated)\s+)?((?:map\s*<[^>]+>)|(?:[A-Za-z_][.\w]*))\s+([A-Za-z_]\w*)\s*=\s*(\d+)\b/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(topLevelBody))) {
    fields.push({
      number: Number(match[4]!),
      name: match[3]!,
      type: normalizeFieldType(match[2]!, packageName),
      label: labelFor(match[1])
    });
  }
  return fields.sort((left, right) => left.number - right.number || left.name.localeCompare(right.name));
}

function stripNestedProtobufBlocks(body: string): string {
  const pattern = /\b(?:message|enum)\s+[A-Za-z_]\w*\s*\{/g;
  let output = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    const openBraceIndex = body.indexOf('{', match.index);
    if (openBraceIndex === -1) break;
    const closeBraceIndex = matchingBraceIndex(body, openBraceIndex);
    if (closeBraceIndex === -1) break;
    output += body.slice(cursor, match.index);
    output += body.slice(match.index, closeBraceIndex + 1).replace(/[^\n]/g, ' ');
    cursor = closeBraceIndex + 1;
    pattern.lastIndex = cursor;
  }
  return output + body.slice(cursor);
}

function normalizeFieldType(typeName: string, packageName: string | undefined): string {
  const normalized = typeName.replace(/\s+/g, '');
  const mapMatch = /^map<([^,>]+),([^>]+)>$/.exec(normalized);
  if (mapMatch) {
    return `map<${qualifyTypeName(mapMatch[1]!, undefined)},${qualifyTypeName(mapMatch[2]!, packageName)}>`;
  }
  return qualifyTypeName(normalized, packageName);
}

function labelFor(label: string | undefined): ProtobufFieldSignature['label'] {
  if (label === 'optional' || label === 'required' || label === 'repeated') return label;
  return 'singular';
}

function qualifyTypeName(typeName: string, packageName: string | undefined): string {
  const normalized = typeName.replace(/^\./, '');
  if (packageName === undefined || normalized.includes('.')) return normalized;
  if (isScalarType(normalized)) return normalized;
  return `${packageName}.${normalized}`;
}

function isScalarType(typeName: string): boolean {
  return PROTOBUF_SCALAR_TYPES.has(typeName);
}

export function stripProtobufComments(content: string): string {
  let output = '';
  let index = 0;
  while (index < content.length) {
    const char = content[index];
    const next = content[index + 1];
    if (char === '/' && next === '/') {
      while (index < content.length && content[index] !== '\n') {
        output += ' ';
        index += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      output += '  ';
      index += 2;
      while (index < content.length) {
        if (content[index] === '*' && content[index + 1] === '/') {
          output += '  ';
          index += 2;
          break;
        }
        output += content[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }
    output += char;
    index += 1;
  }
  return output;
}

function compareOperations(left: ProtobufOperationSignature, right: ProtobufOperationSignature): number {
  return left.service.localeCompare(right.service) || left.rpc.localeCompare(right.rpc);
}
