import type { OpenApiObjectSchemaSignature, OpenApiPropertySignature } from './openapi_compat.js';

export const AVRO_COMPAT_ANALYZER_ID = 'avro-compat-v0';
export const AVRO_COMPAT_SCHEMA_VERSION = 1;
export const AVRO_CONTRACT_KIND = 'avro';
export const AVRO_SYNTHETIC_METHOD = 'AVRO';
export const AVRO_ROOT_PATH = '#';

export type AvroCompatibilitySignature = {
  readonly schemaVersion: typeof AVRO_COMPAT_SCHEMA_VERSION;
  readonly analyzer: typeof AVRO_COMPAT_ANALYZER_ID;
  readonly contractKind: typeof AVRO_CONTRACT_KIND;
  readonly schemas: readonly AvroSchemaSignature[];
};

export type AvroSchemaSignature = {
  readonly id?: string;
  readonly path: typeof AVRO_ROOT_PATH;
  readonly body: OpenApiObjectSchemaSignature;
};

export function extractAvroCompatibility(content: string): AvroCompatibilitySignature | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const body = avroRecordSignature(parsed);
  if (body === undefined) return undefined;
  const id = avroFullName(parsed);
  return {
    schemaVersion: AVRO_COMPAT_SCHEMA_VERSION,
    analyzer: AVRO_COMPAT_ANALYZER_ID,
    contractKind: AVRO_CONTRACT_KIND,
    schemas: [
      {
        ...(id !== undefined ? { id } : {}),
        path: AVRO_ROOT_PATH,
        body
      }
    ]
  };
}

function avroRecordSignature(schema: Record<string, unknown>): OpenApiObjectSchemaSignature | undefined {
  if (schema.type !== 'record' || !Array.isArray(schema.fields)) return undefined;
  const required: string[] = [];
  const properties: Record<string, OpenApiPropertySignature> = {};
  for (const field of schema.fields) {
    if (!isRecord(field) || typeof field.name !== 'string' || field.name.length === 0) continue;
    if (!Object.prototype.hasOwnProperty.call(field, 'default')) required.push(field.name);
    properties[field.name] = { type: avroTypeSignature(field.type) };
  }
  if (required.length === 0 && Object.keys(properties).length === 0) return undefined;
  return {
    required: required.sort((left, right) => left.localeCompare(right)),
    properties: Object.fromEntries(Object.entries(properties).sort(([left], [right]) => left.localeCompare(right)))
  };
}

function avroTypeSignature(schema: unknown): string {
  if (typeof schema === 'string') return schema;
  if (Array.isArray(schema)) {
    const types = [...new Set(schema.map((item) => avroTypeSignature(item)))].sort();
    return types.length === 1 ? types[0]! : types.join('|');
  }
  if (!isRecord(schema)) return 'unknown';
  const type = schema.type;
  if (Array.isArray(type) || typeof type === 'string') return avroTypeSignature(type);
  return 'unknown';
}

function avroFullName(schema: Record<string, unknown>): string | undefined {
  if (typeof schema.name !== 'string' || schema.name.length === 0) return undefined;
  if (schema.name.includes('.')) return schema.name;
  return typeof schema.namespace === 'string' && schema.namespace.length > 0
    ? `${schema.namespace}.${schema.name}`
    : schema.name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
