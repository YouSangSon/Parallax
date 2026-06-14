import {
  extractOpenApiJsonCompatibility,
  OPENAPI_COMPAT_ANALYZER_ID,
  OPENAPI_COMPAT_SCHEMA_VERSION,
  parseOpenApiYamlCompatibility,
  type OpenApiCompatibilityOperation,
  type OpenApiCompatibilitySignature,
  type OpenApiObjectSchemaSignature,
  type OpenApiResponseSignature
} from '../openapi_compat.js';
import { endpointKey, errorMessage, parseJsonObject } from './shared.js';
import type { ContractDiffChange, ContractEndpoint, CurrentContractParse } from './types.js';

type CurrentYamlRoute = {
  path: string;
  indent: number;
  childIndent?: number;
};

const OPENAPI_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

export function classifyOpenApiCompatibilityChanges(
  previous: OpenApiCompatibilitySignature,
  current: OpenApiCompatibilitySignature
): ContractDiffChange[] {
  const previousByKey = compatibilityOperationsByKey(previous.operations);
  const currentByKey = compatibilityOperationsByKey(current.operations);
  const changes: ContractDiffChange[] = [];
  for (const [key, previousOperation] of previousByKey) {
    const currentOperation = currentByKey.get(key);
    if (!currentOperation) continue;
    changes.push(...classifyRequestBodyChanges(previousOperation, currentOperation));
    changes.push(...classifyResponseBodyChanges(previousOperation, currentOperation));
  }
  return changes;
}

function classifyRequestBodyChanges(
  previousOperation: OpenApiCompatibilityOperation,
  currentOperation: OpenApiCompatibilityOperation
): ContractDiffChange[] {
  const previousBody = previousOperation.requestBody;
  const currentBody = currentOperation.requestBody;
  if (currentBody === undefined) return [];
  const changes: ContractDiffChange[] = [];
  const previousRequired = new Set(previousBody?.required ?? []);
  for (const propertyName of currentBody.required) {
    if (previousRequired.has(propertyName)) continue;
    changes.push({
      kind: 'added_request_required_property',
      classification: 'breaking',
      reason: 'request required property added to current contract',
      httpMethod: currentOperation.method,
      routePath: currentOperation.path,
      propertyName,
      schemaPath: `requestBody.required.${propertyName}`
    });
  }
  changes.push(...classifyPropertyTypeChanges({
    kind: 'changed_request_property_type',
    reason: 'request property type changed in current contract',
    httpMethod: currentOperation.method,
    routePath: currentOperation.path,
    schemaPathPrefix: 'requestBody.properties',
    previousBody,
    currentBody
  }));
  return changes;
}

function classifyResponseBodyChanges(
  previousOperation: OpenApiCompatibilityOperation,
  currentOperation: OpenApiCompatibilityOperation
): ContractDiffChange[] {
  const previousResponses = responsesByStatus(previousOperation.responses);
  const currentResponses = responsesByStatus(currentOperation.responses);
  const changes: ContractDiffChange[] = [];
  for (const [statusCode, previousResponse] of previousResponses) {
    const currentResponse = currentResponses.get(statusCode);
    if (!currentResponse) {
      changes.push({
        kind: 'removed_response_status',
        classification: 'breaking',
        reason: 'response status removed from current contract',
        httpMethod: previousOperation.method,
        routePath: previousOperation.path,
        statusCode,
        schemaPath: `responses.${statusCode}`
      });
      continue;
    }
    const previousBody = previousResponse.body;
    if (previousBody === undefined) continue;
    const currentBody = currentResponse.body;
    const currentRequired = new Set(currentBody?.required ?? []);
    for (const propertyName of previousBody.required) {
      if (currentRequired.has(propertyName)) continue;
      changes.push({
        kind: 'removed_response_required_property',
        classification: 'breaking',
        reason: 'response required property removed from current contract',
        httpMethod: previousOperation.method,
        routePath: previousOperation.path,
        statusCode,
        propertyName,
        schemaPath: `responses.${statusCode}.body.required.${propertyName}`
      });
    }
    changes.push(...classifyPropertyTypeChanges({
      kind: 'changed_response_property_type',
      reason: 'response property type changed in current contract',
      httpMethod: previousOperation.method,
      routePath: previousOperation.path,
      statusCode,
      schemaPathPrefix: `responses.${statusCode}.body.properties`,
      previousBody,
      currentBody
    }));
  }
  return changes;
}

function classifyPropertyTypeChanges(options: {
  kind: 'changed_request_property_type' | 'changed_response_property_type';
  reason: string;
  httpMethod: string;
  routePath: string;
  statusCode?: string;
  schemaPathPrefix: string;
  previousBody: OpenApiObjectSchemaSignature | undefined;
  currentBody: OpenApiObjectSchemaSignature | undefined;
}): ContractDiffChange[] {
  if (options.previousBody === undefined || options.currentBody === undefined) return [];
  const changes: ContractDiffChange[] = [];
  for (const [propertyName, previousProperty] of Object.entries(options.previousBody.properties)) {
    const currentProperty = options.currentBody.properties[propertyName];
    if (currentProperty === undefined) continue;
    if (previousProperty.type === currentProperty.type) continue;
    changes.push({
      kind: options.kind,
      classification: 'breaking',
      reason: options.reason,
      httpMethod: options.httpMethod,
      routePath: options.routePath,
      ...(options.statusCode !== undefined ? { statusCode: options.statusCode } : {}),
      propertyName,
      schemaPath: `${options.schemaPathPrefix}.${propertyName}`,
      previousSchemaType: previousProperty.type,
      currentSchemaType: currentProperty.type
    });
  }
  return changes;
}

export function parseOpenApiCompatibility(
  compatibilityJson: string,
  warnings: string[]
): OpenApiCompatibilitySignature | undefined {
  const parsed = parseJsonObject(compatibilityJson);
  if (
    parsed?.analyzer === OPENAPI_COMPAT_ANALYZER_ID &&
    parsed.schemaVersion !== undefined &&
    parsed.schemaVersion !== OPENAPI_COMPAT_SCHEMA_VERSION
  ) {
    warnings.push(
      `indexed OpenAPI compatibility baseline uses schemaVersion ${String(parsed.schemaVersion)}; reindex provider contract for schemaVersion ${OPENAPI_COMPAT_SCHEMA_VERSION}`
    );
    return undefined;
  }
  if (
    parsed?.schemaVersion !== OPENAPI_COMPAT_SCHEMA_VERSION ||
    parsed.analyzer !== OPENAPI_COMPAT_ANALYZER_ID ||
    !Array.isArray(parsed.operations)
  ) {
    return undefined;
  }
  return parsed as OpenApiCompatibilitySignature;
}

function compatibilityOperationsByKey(
  operations: readonly OpenApiCompatibilityOperation[]
): Map<string, OpenApiCompatibilityOperation> {
  const byKey = new Map<string, OpenApiCompatibilityOperation>();
  for (const operation of operations) {
    byKey.set(endpointKey(operation.method, operation.path), operation);
  }
  return byKey;
}

function responsesByStatus(
  responses: readonly OpenApiResponseSignature[]
): Map<string, OpenApiResponseSignature> {
  const byStatus = new Map<string, OpenApiResponseSignature>();
  for (const response of responses) {
    byStatus.set(response.status, response);
  }
  return byStatus;
}

export function parseCurrentOpenApiContract(content: string, contractPath: string): CurrentContractParse {
  if (contractPath.toLowerCase().endsWith('.json')) {
    return parseOpenApiJsonEndpoints(content);
  }
  const parsed = parseOpenApiYamlEndpoints(content);
  if (!parsed.ok) return parsed;
  const compatibility = parseOpenApiYamlCompatibility(content);
  if (!compatibility.ok) {
    return {
      ok: false,
      endpoints: [],
      warning: compatibility.warning
    };
  }
  return {
    ...parsed,
    ...(compatibility.compatibility !== undefined ? { compatibility: compatibility.compatibility } : {})
  };
}

function parseOpenApiJsonEndpoints(content: string): CurrentContractParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      ok: false,
      endpoints: [],
      warning: `current OpenAPI JSON could not be parsed: ${errorMessage(error)}`
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      endpoints: [],
      warning: 'current OpenAPI JSON could not be parsed: root document must be an object'
    };
  }
  const marker = (parsed as { openapi?: unknown; swagger?: unknown }).openapi ??
    (parsed as { openapi?: unknown; swagger?: unknown }).swagger;
  if (typeof marker !== 'string' || marker.length === 0) {
    return {
      ok: false,
      endpoints: [],
      warning: 'current OpenAPI JSON could not be parsed: missing OpenAPI version marker'
    };
  }
  const paths = (parsed as { paths?: unknown }).paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) {
    return {
      ok: false,
      endpoints: [],
      warning: 'current OpenAPI JSON could not be parsed: paths must be an object'
    };
  }
  const endpoints: ContractEndpoint[] = [];
  for (const [routePath, pathItem] of Object.entries(paths as Record<string, unknown>)) {
    if (!routePath.startsWith('/')) continue;
    if (!pathItem || typeof pathItem !== 'object' || Array.isArray(pathItem)) {
      return {
        ok: false,
        endpoints: [],
        warning: `current OpenAPI JSON could not be parsed: path item must be an object for ${routePath}`
      };
    }
    for (const method of Object.keys(pathItem as Record<string, unknown>)) {
      const normalizedMethod = method.toLowerCase();
      if (!OPENAPI_METHODS.has(normalizedMethod)) continue;
      const operation = (pathItem as Record<string, unknown>)[method];
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
        return {
          ok: false,
          endpoints: [],
          warning: `current OpenAPI JSON could not be parsed: operation must be an object for ${normalizedMethod.toUpperCase()} ${routePath}`
        };
      }
      endpoints.push({
        httpMethod: normalizedMethod.toUpperCase(),
        routePath
      });
    }
  }
  const compatibility = extractOpenApiJsonCompatibility(content);
  return {
    ok: true,
    endpoints,
    ...(compatibility !== undefined ? { compatibility } : {})
  };
}

function parseOpenApiYamlEndpoints(content: string): CurrentContractParse {
  if (!/^\s*(?:openapi|swagger)\s*:/im.test(content)) {
    return {
      ok: false,
      endpoints: [],
      warning: 'current OpenAPI YAML could not be parsed: missing OpenAPI version marker'
    };
  }

  const lines = content.split(/\r?\n/);
  const endpoints: ContractEndpoint[] = [];
  let inPaths = false;
  let pathsIndent = -1;
  let currentRoute: CurrentYamlRoute | undefined;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    if (line.includes('\t')) {
      return {
        ok: false,
        endpoints: [],
        warning: 'current OpenAPI YAML could not be parsed: tabs are not supported for indentation'
      };
    }
    const trimmed = stripYamlComment(line).trim();
    if (trimmed.length === 0) continue;
    const indent = leadingSpaces(line);
    if (!inPaths) {
      if (indent !== 0) continue;
      if (/^paths\s*:\s*\{\s*\}\s*(?:#.*)?$/.test(trimmed)) {
        return { ok: true, endpoints: [] };
      }
      if (/^paths\s*:\s*(?:#.*)?$/.test(trimmed)) {
        inPaths = true;
        pathsIndent = indent;
      }
      continue;
    }

    if (indent <= pathsIndent) break;
    const routePath = parseYamlPathEntry(trimmed);
    if (routePath !== undefined) {
      currentRoute = {
        path: routePath,
        indent
      };
      continue;
    }

    if (/^['"]?\//.test(trimmed)) {
      return {
        ok: false,
        endpoints: [],
        warning: 'current OpenAPI YAML could not be parsed: malformed path entry under paths'
      };
    }

    const methodWithoutColon = /^([a-zA-Z]+)\s*$/.exec(trimmed);
    if (methodWithoutColon && OPENAPI_METHODS.has(methodWithoutColon[1]!.toLowerCase())) {
      return {
        ok: false,
        endpoints: [],
        warning: 'current OpenAPI YAML could not be parsed: malformed method entry under paths'
      };
    }

    if (!currentRoute || indent <= currentRoute.indent) {
      const methodBeforePath = /^([a-zA-Z]+)\s*:/.exec(trimmed);
      if (methodBeforePath && OPENAPI_METHODS.has(methodBeforePath[1]!.toLowerCase())) {
        return {
          ok: false,
          endpoints: [],
          warning: 'current OpenAPI YAML could not be parsed: method entry appears before a path'
        };
      }
      continue;
    }
    if (currentRoute.childIndent === undefined || indent < currentRoute.childIndent) {
      currentRoute.childIndent = indent;
    }
    const methodMatch = /^([a-zA-Z]+)\s*:\s*(.*)$/.exec(trimmed);
    if (!methodMatch) continue;
    if (indent !== currentRoute.childIndent) continue;
    const method = methodMatch[1]!.toLowerCase();
    if (!OPENAPI_METHODS.has(method)) continue;
    const inlineValue = methodMatch[2]!.trim();
    if (inlineValue.length > 0 && !(inlineValue.startsWith('{') && inlineValue.endsWith('}'))) {
      return {
        ok: false,
        endpoints: [],
        warning: 'current OpenAPI YAML could not be parsed: operation must be an object under paths'
      };
    }
    if (inlineValue.length === 0 && !hasYamlMappingChild(lines, lineIndex, indent)) {
      return {
        ok: false,
        endpoints: [],
        warning: 'current OpenAPI YAML could not be parsed: operation must be an object under paths'
      };
    }
    endpoints.push({
      httpMethod: method.toUpperCase(),
      routePath: currentRoute.path
    });
  }

  if (!inPaths) {
    return {
      ok: false,
      endpoints: [],
      warning: 'current OpenAPI YAML could not be parsed: missing paths object'
    };
  }

  return { ok: true, endpoints };
}

function stripYamlComment(line: string): string {
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const previous = index > 0 ? line[index - 1] : undefined;
    if (quote === undefined && (char === '"' || char === "'")) {
      quote = char;
      continue;
    }
    if (quote !== undefined && char === quote && previous !== '\\') {
      quote = undefined;
      continue;
    }
    if (quote === undefined && char === '#') {
      return line.slice(0, index);
    }
  }
  return line;
}

function leadingSpaces(line: string): number {
  return line.match(/^ */)?.[0].length ?? 0;
}

function parseYamlPathEntry(trimmed: string): string | undefined {
  const quoted = /^(['"])(\/.*?)\1\s*:\s*(?:#.*)?$/.exec(trimmed);
  if (quoted) return quoted[2]!;
  const unquoted = /^(\/.*)\s*:\s*(?:#.*)?$/.exec(trimmed);
  return unquoted?.[1]?.trimEnd();
}

function hasYamlMappingChild(lines: string[], parentLineIndex: number, parentIndent: number): boolean {
  for (const line of lines.slice(parentLineIndex + 1)) {
    const trimmed = stripYamlComment(line).trim();
    if (trimmed.length === 0) continue;
    if (leadingSpaces(line) <= parentIndent) return false;
    return /^['"]?[A-Za-z0-9_$.-]+['"]?\s*:/.test(trimmed);
  }
  return false;
}
