export const GRAPHQL_COMPAT_ANALYZER_ID = 'graphql-compat-v0';
export const GRAPHQL_COMPAT_SCHEMA_VERSION = 1;

export type GraphqlCompatibilitySignature = {
  readonly schemaVersion: typeof GRAPHQL_COMPAT_SCHEMA_VERSION;
  readonly analyzer: typeof GRAPHQL_COMPAT_ANALYZER_ID;
  readonly contractKind: 'graphql';
  readonly operations: readonly GraphqlOperationSignature[];
  readonly objectTypes: readonly GraphqlObjectTypeSignature[];
  readonly inputTypes: readonly GraphqlInputTypeSignature[];
};

export type GraphqlOperationSignature = {
  readonly rootType: GraphqlRootType;
  readonly field: string;
  readonly path: string;
  readonly returnType: string;
  readonly args: readonly GraphqlArgumentSignature[];
};

export type GraphqlArgumentSignature = {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
};

export type GraphqlObjectTypeSignature = {
  readonly name: string;
  readonly fields: readonly GraphqlFieldSignature[];
};

export type GraphqlInputTypeSignature = {
  readonly name: string;
  readonly fields: readonly GraphqlInputFieldSignature[];
};

export type GraphqlFieldSignature = {
  readonly name: string;
  readonly type: string;
};

export type GraphqlInputFieldSignature = GraphqlFieldSignature & {
  readonly required: boolean;
};

type GraphqlRootType = 'Query' | 'Mutation' | 'Subscription';

type GraphqlBlock = {
  kind: 'type' | 'input';
  name: string;
  body: string;
};

export function extractGraphqlCompatibility(content: string): GraphqlCompatibilitySignature | undefined {
  const stripped = stripGraphqlComments(content);
  const operations: GraphqlOperationSignature[] = [];
  const objectTypes = new Map<string, Map<string, GraphqlFieldSignature>>();
  const inputTypes = new Map<string, Map<string, GraphqlInputFieldSignature>>();

  for (const block of graphqlBlocks(stripped)) {
    if (block.kind === 'input') {
      const fields = inputFieldSignatures(block.body);
      mergeFields(inputTypes, block.name, fields);
      continue;
    }

    const fields = fieldSignatures(block.body);
    if (isGraphqlRootType(block.name)) {
      for (const field of fields) {
        operations.push({
          rootType: block.name,
          field: field.name,
          path: `${block.name}.${field.name}`,
          returnType: field.type,
          args: field.args
        });
      }
    } else {
      mergeFields(objectTypes, block.name, fields.map(({ name, type }) => ({ name, type })));
    }
  }

  if (operations.length === 0 && objectTypes.size === 0 && inputTypes.size === 0) return undefined;
  return {
    schemaVersion: GRAPHQL_COMPAT_SCHEMA_VERSION,
    analyzer: GRAPHQL_COMPAT_ANALYZER_ID,
    contractKind: 'graphql',
    operations: operations.sort(compareOperations),
    objectTypes: mapToTypeSignatures(objectTypes),
    inputTypes: mapToTypeSignatures(inputTypes)
  };
}

export function stripGraphqlComments(content: string): string {
  let output = '';
  for (const line of content.split(/(\r?\n)/)) {
    if (line === '\n' || line === '\r\n') {
      output += line;
      continue;
    }
    const commentIndex = line.indexOf('#');
    output += commentIndex === -1
      ? line
      : `${line.slice(0, commentIndex)}${' '.repeat(line.length - commentIndex)}`;
  }
  return output;
}

function graphqlBlocks(content: string): GraphqlBlock[] {
  const blocks: GraphqlBlock[] = [];
  const pattern = /\b(?:extend\s+)?(type|input)\s+([A-Za-z_]\w*)[^{]*\{/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    const openBraceIndex = content.indexOf('{', match.index);
    if (openBraceIndex === -1) continue;
    const closeBraceIndex = matchingBraceIndex(content, openBraceIndex);
    if (closeBraceIndex === -1) continue;
    blocks.push({
      kind: match[1] as 'type' | 'input',
      name: match[2]!,
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

function fieldSignatures(body: string): Array<GraphqlFieldSignature & { args: GraphqlArgumentSignature[] }> {
  const fields: Array<GraphqlFieldSignature & { args: GraphqlArgumentSignature[] }> = [];
  const pattern = /^\s*([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:\s*([^@\n]+)(?:@.*)?$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    fields.push({
      name: match[1]!,
      type: normalizeGraphqlType(match[3]!),
      args: argumentSignatures(match[2])
    });
  }
  return fields.sort((left, right) => left.name.localeCompare(right.name));
}

function inputFieldSignatures(body: string): GraphqlInputFieldSignature[] {
  const fields: GraphqlInputFieldSignature[] = [];
  const pattern = /^\s*([A-Za-z_]\w*)\s*:\s*([^@\n]+)(?:@.*)?$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    const field = graphqlInputPart(`${match[1]}: ${match[2]}`);
    if (field === undefined) continue;
    fields.push(field);
  }
  return fields.sort((left, right) => left.name.localeCompare(right.name));
}

function argumentSignatures(argsText: string | undefined): GraphqlArgumentSignature[] {
  if (argsText === undefined) return [];
  return splitTopLevel(argsText, ',')
    .map((part) => graphqlInputPart(part))
    .filter((part): part is GraphqlArgumentSignature => part !== undefined)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function graphqlInputPart(part: string): GraphqlArgumentSignature | undefined {
  const colonIndex = part.indexOf(':');
  if (colonIndex === -1) return undefined;
  const name = part.slice(0, colonIndex).trim();
  if (!/^[A-Za-z_]\w*$/.test(name)) return undefined;
  const remainder = part.slice(colonIndex + 1);
  const defaultIndex = topLevelIndexOf(remainder, '=');
  const directiveIndex = topLevelIndexOf(remainder, '@');
  const endIndex = minDefined(defaultIndex, directiveIndex) ?? remainder.length;
  const hasDefault = defaultIndex !== undefined;
  const type = normalizeGraphqlType(remainder.slice(0, endIndex));
  if (type.length === 0) return undefined;
  return {
    name,
    type,
    required: isRequiredGraphqlInput(type, hasDefault)
  };
}

function normalizeGraphqlType(typeName: string): string {
  return typeName.trim().replace(/\s+/g, '');
}

function isRequiredGraphqlInput(typeName: string, hasDefault: boolean): boolean {
  return typeName.endsWith('!') && !hasDefault;
}

function splitTopLevel(input: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '[' || char === '(' || char === '{') {
      depth += 1;
    } else if (char === ']' || char === ')' || char === '}') {
      depth = Math.max(0, depth - 1);
    } else if (char === delimiter && depth === 0) {
      parts.push(input.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(input.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

function topLevelIndexOf(input: string, target: string): number | undefined {
  let depth = 0;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '[' || char === '(' || char === '{') {
      depth += 1;
    } else if (char === ']' || char === ')' || char === '}') {
      depth = Math.max(0, depth - 1);
    } else if (char === target && depth === 0) {
      return index;
    }
  }
  return undefined;
}

function minDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function isGraphqlRootType(typeName: string): typeName is GraphqlRootType {
  return typeName === 'Query' || typeName === 'Mutation' || typeName === 'Subscription';
}

function mergeFields<T extends { name: string }>(
  types: Map<string, Map<string, T>>,
  typeName: string,
  fields: readonly T[]
): void {
  const existing = types.get(typeName) ?? new Map<string, T>();
  for (const field of fields) {
    existing.set(field.name, field);
  }
  types.set(typeName, existing);
}

function mapToTypeSignatures<T extends { name: string }>(
  types: Map<string, Map<string, T>>
): Array<{ name: string; fields: T[] }> {
  return [...types.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, fields]) => ({
      name,
      fields: [...fields.values()].sort((left, right) => left.name.localeCompare(right.name))
    }));
}

function compareOperations(left: GraphqlOperationSignature, right: GraphqlOperationSignature): number {
  return left.rootType.localeCompare(right.rootType) || left.field.localeCompare(right.field);
}
