export const OPENAPI_COMPAT_ANALYZER_ID = 'openapi-compat-v0';
export const OPENAPI_COMPAT_SCHEMA_VERSION = 1;

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

const OPENAPI_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

export function extractOpenApiJsonCompatibility(content: string): OpenApiCompatibilitySignature | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
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
  const schema = resolveMaybeRef(root, schemaValue, seenRefs);
  if (!isRecord(schema)) return undefined;
  const properties = schema.properties;
  const required = schema.required;
  if (!isRecord(properties) && !Array.isArray(required)) return undefined;
  const propertySignatures: Record<string, OpenApiPropertySignature> = {};
  if (isRecord(properties)) {
    for (const [propertyName, propertySchema] of Object.entries(properties).sort(([left], [right]) => left.localeCompare(right))) {
      propertySignatures[propertyName] = { type: schemaType(root, propertySchema, new Set(seenRefs)) };
    }
  }
  return {
    required: Array.isArray(required)
      ? required.filter((item): item is string => typeof item === 'string').sort((left, right) => left.localeCompare(right))
      : [],
    properties: propertySignatures
  };
}

function schemaType(root: Record<string, unknown>, schemaValue: unknown, seenRefs: Set<string>): string {
  const schema = resolveMaybeRef(root, schemaValue, seenRefs);
  if (!isRecord(schema)) return 'unknown';
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
