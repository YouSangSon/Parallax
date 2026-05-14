import { parse as parseYaml } from 'yaml';

export const OPENAPI_COMPAT_ANALYZER_ID = 'openapi-compat-v0';
export const OPENAPI_COMPAT_SCHEMA_VERSION = 2;

export type OpenApiCompatibilitySignature = {
  readonly schemaVersion: typeof OPENAPI_COMPAT_SCHEMA_VERSION;
  readonly analyzer: typeof OPENAPI_COMPAT_ANALYZER_ID;
  readonly operations: readonly OpenApiCompatibilityOperation[];
};

export type OpenApiCompatibilityOperation = {
  readonly method: string;
  readonly path: string;
  readonly requestBody?: OpenApiObjectSchemaSignature;
  readonly responses: readonly OpenApiResponseSignature[];
};

export type OpenApiResponseSignature = {
  readonly status: string;
  readonly body?: OpenApiObjectSchemaSignature;
};

export type OpenApiObjectSchemaSignature = {
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, OpenApiPropertySignature>>;
};

export type OpenApiPropertySignature = {
  readonly type: string;
};

export type OpenApiYamlCompatibilityParse =
  | {
      readonly ok: true;
      readonly compatibility?: OpenApiCompatibilitySignature;
    }
  | {
      readonly ok: false;
      readonly warning: string;
    };

const OPENAPI_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const MAX_SCHEMA_SIGNATURE_DEPTH = 8;

type SchemaSignatureBuilder = {
  required: Set<string>;
  properties: Map<string, Set<string>>;
};

type SchemaTraversalState = {
  seenRefs: Set<string>;
  activeSchemas: Set<Record<string, unknown>>;
  depth: number;
};

export function extractOpenApiJsonCompatibility(content: string): OpenApiCompatibilitySignature | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  return extractOpenApiCompatibility(parsed);
}

export function extractOpenApiYamlCompatibility(content: string): OpenApiCompatibilitySignature | undefined {
  const result = parseOpenApiYamlCompatibility(content);
  return result.ok ? result.compatibility : undefined;
}

export function parseOpenApiYamlCompatibility(content: string): OpenApiYamlCompatibilityParse {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (error) {
    return {
      ok: false,
      warning: `current OpenAPI YAML could not be parsed: ${errorMessage(error)}`
    };
  }
  const compatibility = extractOpenApiCompatibility(parsed);
  return {
    ok: true,
    ...(compatibility !== undefined ? { compatibility } : {})
  };
}

function extractOpenApiCompatibility(parsed: unknown): OpenApiCompatibilitySignature | undefined {
  if (!isRecord(parsed)) return undefined;
  const marker = parsed.openapi ?? parsed.swagger;
  if (typeof marker !== 'string' || marker.length === 0) return undefined;
  const paths = parsed.paths;
  if (!isRecord(paths)) return undefined;

  const operations: OpenApiCompatibilityOperation[] = [];
  for (const [routePath, pathItem] of Object.entries(paths)) {
    if (!routePath.startsWith('/') || !isRecord(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      const normalizedMethod = method.toLowerCase();
      if (!OPENAPI_METHODS.has(normalizedMethod)) continue;
      if (!isRecord(operation)) return undefined;
      operations.push(operationSignature(parsed, routePath, normalizedMethod.toUpperCase(), operation));
    }
  }

  operations.sort(compareOperations);
  return {
    schemaVersion: OPENAPI_COMPAT_SCHEMA_VERSION,
    analyzer: OPENAPI_COMPAT_ANALYZER_ID,
    operations
  };
}

function operationSignature(
  root: Record<string, unknown>,
  routePath: string,
  method: string,
  operation: Record<string, unknown>
): OpenApiCompatibilityOperation {
  const requestBody = requestBodySignature(root, operation);
  const responses = responseSignatures(root, operation);
  return {
    method,
    path: routePath,
    ...(requestBody !== undefined ? { requestBody } : {}),
    responses
  };
}

function requestBodySignature(
  root: Record<string, unknown>,
  operation: Record<string, unknown>
): OpenApiObjectSchemaSignature | undefined {
  const requestBody = resolveMaybeRef(root, operation.requestBody);
  if (!isRecord(requestBody)) return undefined;
  return contentObjectSchemaSignature(root, requestBody);
}

function responseSignatures(
  root: Record<string, unknown>,
  operation: Record<string, unknown>
): OpenApiResponseSignature[] {
  const responses = operation.responses;
  if (!isRecord(responses)) return [];
  const signatures: OpenApiResponseSignature[] = [];
  for (const [status, responseValue] of Object.entries(responses)) {
    const response = resolveMaybeRef(root, responseValue);
    if (!isRecord(response)) continue;
    const body = contentObjectSchemaSignature(root, response);
    signatures.push({
      status,
      ...(body !== undefined ? { body } : {})
    });
  }
  return signatures.sort((left, right) => left.status.localeCompare(right.status));
}

function contentObjectSchemaSignature(
  root: Record<string, unknown>,
  holder: Record<string, unknown>
): OpenApiObjectSchemaSignature | undefined {
  const media = selectJsonMediaContent(holder.content);
  if (!media) return undefined;
  return objectSchemaSignature(root, media.schema, new Set());
}

function selectJsonMediaContent(content: unknown): Record<string, unknown> | undefined {
  if (!isRecord(content)) return undefined;
  const entries = Object.entries(content);
  const exact = entries.find(([mediaType]) => mediaType.toLowerCase() === 'application/json');
  const suffixJson = entries.find(([mediaType]) => /\+json(?:\s*;|$)/i.test(mediaType));
  const anyJson = entries.find(([mediaType]) => /json/i.test(mediaType));
  const selected = exact ?? suffixJson ?? anyJson;
  return selected && isRecord(selected[1]) ? selected[1] : undefined;
}

function objectSchemaSignature(
  root: Record<string, unknown>,
  schemaValue: unknown,
  seenRefs: Set<string>
): OpenApiObjectSchemaSignature | undefined {
  const builder: SchemaSignatureBuilder = {
    required: new Set(),
    properties: new Map()
  };
  collectObjectSchemaSignature(root, schemaValue, '', builder, {
    seenRefs: new Set(seenRefs),
    activeSchemas: new Set(),
    depth: 0
  });
  if (builder.required.size === 0 && builder.properties.size === 0) return undefined;
  return {
    required: [...builder.required].sort((left, right) => left.localeCompare(right)),
    properties: Object.fromEntries(
      [...builder.properties.entries()].sort(([left], [right]) => left.localeCompare(right))
        .map(([propertyName, propertyTypes]) => [propertyName, { type: propertyTypeSignature(propertyTypes) }])
    )
  };
}

function collectObjectSchemaSignature(
  root: Record<string, unknown>,
  schemaValue: unknown,
  pathPrefix: string,
  builder: SchemaSignatureBuilder,
  state: SchemaTraversalState
): boolean {
  if (state.depth > MAX_SCHEMA_SIGNATURE_DEPTH) return false;
  const schema = resolveMaybeRef(root, schemaValue, state.seenRefs);
  if (!isRecord(schema)) return false;
  if (state.activeSchemas.has(schema)) return false;
  state.activeSchemas.add(schema);
  try {
    let collected = false;
    if (Array.isArray(schema.allOf)) {
      for (const part of schema.allOf) {
        if (collectObjectSchemaSignature(root, part, pathPrefix, builder, nextTraversalState(state))) {
          collected = true;
        }
      }
    }
    if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
      recordPropertyType(builder, pathPrefix || '$', schemaType(root, schema, new Set(state.seenRefs)));
      collected = true;
    }

    if (Array.isArray(schema.required)) {
      for (const propertyName of schema.required) {
        if (typeof propertyName !== 'string') continue;
        builder.required.add(appendPropertyPath(pathPrefix, propertyName));
        collected = true;
      }
    }

    if (isRecord(schema.properties)) {
      for (const [propertyName, propertySchema] of Object.entries(schema.properties).sort(([left], [right]) => left.localeCompare(right))) {
        const propertyPath = appendPropertyPath(pathPrefix, propertyName);
        recordPropertyType(builder, propertyPath, schemaType(root, propertySchema, new Set(state.seenRefs)));
        collectNestedPropertySignature(root, propertySchema, propertyPath, builder, nextTraversalState(state));
        collected = true;
      }
    }

    if (schema.items !== undefined) {
      const itemPath = `${pathPrefix}[]`;
      recordPropertyType(builder, itemPath, schemaType(root, schema.items, new Set(state.seenRefs)));
      collectNestedPropertySignature(root, schema.items, itemPath, builder, nextTraversalState(state));
      collected = true;
    }

    return collected;
  } finally {
    state.activeSchemas.delete(schema);
  }
}

function collectNestedPropertySignature(
  root: Record<string, unknown>,
  schemaValue: unknown,
  propertyPath: string,
  builder: SchemaSignatureBuilder,
  state: SchemaTraversalState
): void {
  if (state.depth > MAX_SCHEMA_SIGNATURE_DEPTH) return;
  const schema = resolveMaybeRef(root, schemaValue, state.seenRefs);
  if (!isRecord(schema)) return;
  if (Array.isArray(schema.allOf) || isRecord(schema.properties) || Array.isArray(schema.required)) {
    collectObjectSchemaSignature(root, schemaValue, propertyPath, builder, nextTraversalState(state));
  }
  if (schema.items !== undefined) {
    const itemPath = `${propertyPath}[]`;
    recordPropertyType(builder, itemPath, schemaType(root, schema.items, new Set(state.seenRefs)));
    collectNestedPropertySignature(root, schema.items, itemPath, builder, nextTraversalState(state));
  }
}

function schemaType(root: Record<string, unknown>, schemaValue: unknown, seenRefs: Set<string>): string {
  const schema = resolveMaybeRef(root, schemaValue, seenRefs);
  if (!isRecord(schema)) return 'unknown';
  const oneOfType = compositionSchemaType(root, schema, 'oneOf', seenRefs);
  if (oneOfType !== undefined) return oneOfType;
  const anyOfType = compositionSchemaType(root, schema, 'anyOf', seenRefs);
  if (anyOfType !== undefined) return anyOfType;
  const allOfType = allOfSchemaType(root, schema, seenRefs);
  if (allOfType !== undefined) return allOfType;
  const type = schema.type;
  if (typeof type === 'string' && type.length > 0) return type;
  if (Array.isArray(type)) {
    const types = type.filter((item): item is string => typeof item === 'string').sort();
    if (types.length > 0) return types.join('|');
  }
  if (isRecord(schema.properties)) return 'object';
  if (schema.items !== undefined) return 'array';
  if (Array.isArray(schema.enum)) return 'enum';
  return 'unknown';
}

function allOfSchemaType(root: Record<string, unknown>, schema: Record<string, unknown>, seenRefs: Set<string>): string | undefined {
  if (!Array.isArray(schema.allOf) || schema.allOf.length === 0) return undefined;
  const fingerprints = uniqueSorted(
    schema.allOf.map((part) => schemaTypeFingerprint(root, part, new Set(seenRefs), 0))
  );
  if (fingerprints.some((fingerprint) => fingerprint.startsWith('object'))) return 'object';
  return `allOf<${fingerprints.join('|')}>`;
}

function compositionSchemaType(
  root: Record<string, unknown>,
  schema: Record<string, unknown>,
  keyword: 'oneOf' | 'anyOf',
  seenRefs: Set<string>
): string | undefined {
  const variants = schema[keyword];
  if (!Array.isArray(variants) || variants.length === 0) return undefined;
  const fingerprints = uniqueSorted(
    variants.map((variant) => schemaTypeFingerprint(root, variant, new Set(seenRefs), 0))
  );
  return `${keyword}<${fingerprints.join('|')}>`;
}

function schemaTypeFingerprint(
  root: Record<string, unknown>,
  schemaValue: unknown,
  seenRefs: Set<string>,
  depth: number
): string {
  if (depth > MAX_SCHEMA_SIGNATURE_DEPTH) return 'unknown';
  const schema = resolveMaybeRef(root, schemaValue, seenRefs);
  if (!isRecord(schema)) return 'unknown';
  const oneOfType = compositionFingerprint(root, schema, 'oneOf', seenRefs, depth);
  if (oneOfType !== undefined) return oneOfType;
  const anyOfType = compositionFingerprint(root, schema, 'anyOf', seenRefs, depth);
  if (anyOfType !== undefined) return anyOfType;
  const allOfType = compositionFingerprint(root, schema, 'allOf', seenRefs, depth);
  if (allOfType !== undefined) return allOfType;
  const type = schema.type;
  if (Array.isArray(type)) {
    const types = type.filter((item): item is string => typeof item === 'string');
    if (types.length > 0) return uniqueSorted(types).join('|');
  }
  if (isRecord(schema.properties) || Array.isArray(schema.required)) {
    const entries = isRecord(schema.properties)
      ? Object.entries(schema.properties)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([propertyName, propertySchema]) =>
            `${propertyName}:${schemaTypeFingerprint(root, propertySchema, new Set(seenRefs), depth + 1)}`
          )
      : [];
    return `object{required:${requiredFingerprint(schema.required)};properties:${entries.join(',')}}`;
  }
  if (schema.items !== undefined) {
    return `array<${schemaTypeFingerprint(root, schema.items, new Set(seenRefs), depth + 1)}>`;
  }
  if (typeof type === 'string' && type.length > 0) return type;
  if (Array.isArray(schema.enum)) return 'enum';
  if (Array.isArray(schema.required)) return 'object';
  return 'unknown';
}

function requiredFingerprint(required: unknown): string {
  if (!Array.isArray(required)) return '';
  return uniqueSorted(required.filter((item): item is string => typeof item === 'string')).join('|');
}

function compositionFingerprint(
  root: Record<string, unknown>,
  schema: Record<string, unknown>,
  keyword: 'allOf' | 'oneOf' | 'anyOf',
  seenRefs: Set<string>,
  depth: number
): string | undefined {
  const variants = schema[keyword];
  if (!Array.isArray(variants) || variants.length === 0) return undefined;
  const fingerprints = uniqueSorted(
    variants.map((variant) => schemaTypeFingerprint(root, variant, new Set(seenRefs), depth + 1))
  );
  return `${keyword}<${fingerprints.join('|')}>`;
}

function appendPropertyPath(pathPrefix: string, propertyName: string): string {
  return pathPrefix.length === 0 ? propertyName : `${pathPrefix}.${propertyName}`;
}

function recordPropertyType(builder: SchemaSignatureBuilder, propertyPath: string, propertyType: string): void {
  const existing = builder.properties.get(propertyPath);
  if (existing) {
    existing.add(propertyType);
    return;
  }
  builder.properties.set(propertyPath, new Set([propertyType]));
}

function propertyTypeSignature(propertyTypes: Set<string>): string {
  const types = uniqueSorted([...propertyTypes]);
  return types.length === 1 ? types[0]! : `allOf<${types.join('|')}>`;
}

function nextTraversalState(state: SchemaTraversalState): SchemaTraversalState {
  return {
    seenRefs: new Set(state.seenRefs),
    activeSchemas: state.activeSchemas,
    depth: state.depth + 1
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function resolveMaybeRef(
  root: Record<string, unknown>,
  value: unknown,
  seenRefs = new Set<string>()
): unknown {
  if (!isRecord(value)) return value;
  const ref = value.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return value;
  if (seenRefs.has(ref)) return undefined;
  const nextSeenRefs = new Set(seenRefs);
  nextSeenRefs.add(ref);
  return resolveMaybeRef(root, resolveJsonPointer(root, ref.slice(1)), nextSeenRefs);
}

function resolveJsonPointer(root: Record<string, unknown>, pointer: string): unknown {
  const segments = pointer
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return undefined;
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function compareOperations(left: OpenApiCompatibilityOperation, right: OpenApiCompatibilityOperation): number {
  return left.path.localeCompare(right.path) || left.method.localeCompare(right.method);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
