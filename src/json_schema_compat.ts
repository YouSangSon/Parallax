import {
  objectSchemaSignature,
  type OpenApiObjectSchemaSignature
} from './openapi_compat.js';

export const JSON_SCHEMA_COMPAT_ANALYZER_ID = 'json-schema-compat-v0';
export const JSON_SCHEMA_COMPAT_SCHEMA_VERSION = 1;
export const JSON_SCHEMA_CONTRACT_KIND = 'json-schema';
export const JSON_SCHEMA_SYNTHETIC_METHOD = 'SCHEMA';
export const JSON_SCHEMA_ROOT_PATH = '#';

export type JsonSchemaCompatibilitySignature = {
  readonly schemaVersion: typeof JSON_SCHEMA_COMPAT_SCHEMA_VERSION;
  readonly analyzer: typeof JSON_SCHEMA_COMPAT_ANALYZER_ID;
  readonly contractKind: typeof JSON_SCHEMA_CONTRACT_KIND;
  readonly schemas: readonly JsonSchemaSignature[];
};

export type JsonSchemaSignature = {
  readonly id?: string;
  readonly path: typeof JSON_SCHEMA_ROOT_PATH;
  readonly body: OpenApiObjectSchemaSignature;
};

export function extractJsonSchemaCompatibility(content: string): JsonSchemaCompatibilitySignature | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const body = objectSchemaSignature(parsed, parsed, new Set());
  if (body === undefined) return undefined;
  const id = typeof parsed.$id === 'string' && parsed.$id.length > 0 ? parsed.$id : undefined;
  return {
    schemaVersion: JSON_SCHEMA_COMPAT_SCHEMA_VERSION,
    analyzer: JSON_SCHEMA_COMPAT_ANALYZER_ID,
    contractKind: JSON_SCHEMA_CONTRACT_KIND,
    schemas: [
      {
        ...(id !== undefined ? { id } : {}),
        path: JSON_SCHEMA_ROOT_PATH,
        body
      }
    ]
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
