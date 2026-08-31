import {
  AVRO_COMPAT_ANALYZER_ID,
  AVRO_COMPAT_SCHEMA_VERSION,
  AVRO_CONTRACT_KIND,
  AVRO_SYNTHETIC_METHOD,
  extractAvroCompatibility,
  type AvroCompatibilitySignature
} from '../avro_compat.js';
import { errorMessage, parseJsonObject } from './shared.js';
import { classifyProducedSchemaChanges } from './json_schema.js';
import type { ContractDiffChange, ContractEndpoint, CurrentContractParse } from './types.js';

export function classifyAvroCompatibilityChanges(
  previous: AvroCompatibilitySignature,
  current: AvroCompatibilitySignature
): ContractDiffChange[] {
  const currentByPath = new Map(current.schemas.map((schema) => [schema.path, schema]));
  const changes: ContractDiffChange[] = [];
  for (const previousSchema of previous.schemas) {
    const currentSchema = currentByPath.get(previousSchema.path);
    if (currentSchema === undefined) continue;
    changes.push(
      ...classifyProducedSchemaChanges(previousSchema.body, currentSchema.body, previousSchema.path, {
        contractLabel: 'Avro schema',
        syntheticMethod: AVRO_SYNTHETIC_METHOD
      })
    );
  }
  return changes;
}

export function parseAvroCompatibility(
  compatibilityJson: string,
  warnings: string[]
): AvroCompatibilitySignature | undefined {
  const parsed = parseJsonObject(compatibilityJson);
  if (
    parsed?.analyzer === AVRO_COMPAT_ANALYZER_ID &&
    parsed.schemaVersion !== undefined &&
    parsed.schemaVersion !== AVRO_COMPAT_SCHEMA_VERSION
  ) {
    warnings.push(
      `indexed Avro compatibility baseline uses schemaVersion ${String(parsed.schemaVersion)}; reindex provider contract for schemaVersion ${AVRO_COMPAT_SCHEMA_VERSION}`
    );
    return undefined;
  }
  if (
    parsed?.schemaVersion !== AVRO_COMPAT_SCHEMA_VERSION ||
    parsed.analyzer !== AVRO_COMPAT_ANALYZER_ID ||
    parsed.contractKind !== AVRO_CONTRACT_KIND ||
    !Array.isArray(parsed.schemas)
  ) {
    return undefined;
  }
  return parsed as AvroCompatibilitySignature;
}

export function parseCurrentAvroContract(content: string): CurrentContractParse {
  try {
    JSON.parse(content);
  } catch (error) {
    return {
      ok: false,
      endpoints: [],
      warning: `current Avro contract could not be parsed: ${errorMessage(error)}`
    };
  }
  const compatibility = extractAvroCompatibility(content);
  if (compatibility === undefined) {
    return {
      ok: false,
      endpoints: [],
      warning: 'current Avro contract could not be parsed: no record schema signature found'
    };
  }
  return {
    ok: true,
    endpoints: avroEndpoints(compatibility),
    avroCompatibility: compatibility
  };
}

function avroEndpoints(compatibility: AvroCompatibilitySignature): ContractEndpoint[] {
  return compatibility.schemas.map((schema) => ({
    endpointId: `endpoint:avro:${schema.path}`,
    httpMethod: AVRO_SYNTHETIC_METHOD,
    routePath: schema.path
  }));
}
