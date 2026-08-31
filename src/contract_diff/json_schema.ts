import {
  JSON_SCHEMA_COMPAT_ANALYZER_ID,
  JSON_SCHEMA_COMPAT_SCHEMA_VERSION,
  JSON_SCHEMA_CONTRACT_KIND,
  JSON_SCHEMA_SYNTHETIC_METHOD,
  extractJsonSchemaCompatibility,
  type JsonSchemaCompatibilitySignature
} from '../json_schema_compat.js';
import type { OpenApiObjectSchemaSignature } from '../openapi_compat.js';
import { errorMessage, parseJsonObject } from './shared.js';
import type { ContractDiffChange, ContractEndpoint, CurrentContractParse } from './types.js';

export function classifyJsonSchemaCompatibilityChanges(
  previous: JsonSchemaCompatibilitySignature,
  current: JsonSchemaCompatibilitySignature
): ContractDiffChange[] {
  const currentByPath = new Map(current.schemas.map((schema) => [schema.path, schema]));
  const changes: ContractDiffChange[] = [];
  for (const previousSchema of previous.schemas) {
    const currentSchema = currentByPath.get(previousSchema.path);
    if (currentSchema === undefined) continue;
    changes.push(...classifyProducedSchemaChanges(previousSchema.body, currentSchema.body, previousSchema.path));
  }
  return changes;
}

export function parseJsonSchemaCompatibility(
  compatibilityJson: string,
  warnings: string[]
): JsonSchemaCompatibilitySignature | undefined {
  const parsed = parseJsonObject(compatibilityJson);
  if (
    parsed?.analyzer === JSON_SCHEMA_COMPAT_ANALYZER_ID &&
    parsed.schemaVersion !== undefined &&
    parsed.schemaVersion !== JSON_SCHEMA_COMPAT_SCHEMA_VERSION
  ) {
    warnings.push(
      `indexed JSON Schema compatibility baseline uses schemaVersion ${String(parsed.schemaVersion)}; reindex provider contract for schemaVersion ${JSON_SCHEMA_COMPAT_SCHEMA_VERSION}`
    );
    return undefined;
  }
  if (
    parsed?.schemaVersion !== JSON_SCHEMA_COMPAT_SCHEMA_VERSION ||
    parsed.analyzer !== JSON_SCHEMA_COMPAT_ANALYZER_ID ||
    parsed.contractKind !== JSON_SCHEMA_CONTRACT_KIND ||
    !Array.isArray(parsed.schemas)
  ) {
    return undefined;
  }
  return parsed as JsonSchemaCompatibilitySignature;
}

export function parseCurrentJsonSchemaContract(content: string): CurrentContractParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      ok: false,
      endpoints: [],
      warning: `current JSON Schema contract could not be parsed: ${errorMessage(error)}`
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      endpoints: [],
      warning: 'current JSON Schema contract could not be parsed: expected object schema'
    };
  }
  const compatibility = extractJsonSchemaCompatibility(content);
  if (compatibility === undefined) {
    return {
      ok: false,
      endpoints: [],
      warning: 'current JSON Schema contract could not be parsed: no object schema signature found'
    };
  }
  return {
    ok: true,
    endpoints: jsonSchemaEndpoints(compatibility),
    jsonSchemaCompatibility: compatibility
  };
}

export function classifyProducedSchemaChanges(
  previousBody: OpenApiObjectSchemaSignature,
  currentBody: OpenApiObjectSchemaSignature,
  schemaPath: string,
  context: ProducedSchemaDiffContext = {
    contractLabel: 'JSON Schema',
    syntheticMethod: JSON_SCHEMA_SYNTHETIC_METHOD
  }
): ContractDiffChange[] {
  return [
    ...classifyRequiredPropertyRemovals(previousBody, currentBody, schemaPath, context),
    ...classifyOptionalPropertyRemovals(previousBody, currentBody, schemaPath, context),
    ...classifyPropertyTypeChanges(previousBody, currentBody, schemaPath, context),
    ...classifyNullableAdditions(previousBody, currentBody, schemaPath, context)
  ];
}

type ProducedSchemaDiffContext = {
  contractLabel: string;
  syntheticMethod: string;
};

function classifyRequiredPropertyRemovals(
  previousBody: OpenApiObjectSchemaSignature,
  currentBody: OpenApiObjectSchemaSignature,
  schemaPath: string,
  context: ProducedSchemaDiffContext
): ContractDiffChange[] {
  const currentRequired = new Set(currentBody.required);
  return previousBody.required.flatMap((propertyName): ContractDiffChange[] =>
    currentRequired.has(propertyName)
      ? []
      : [{
          kind: 'removed_response_required_property',
          classification: 'breaking',
          reason: `${context.contractLabel} required property removed from current contract`,
          httpMethod: context.syntheticMethod,
          routePath: schemaPath,
          statusCode: 'schema',
          propertyName,
          schemaPath: `${schemaPath}.required.${propertyName}`
        }]
  );
}

function classifyOptionalPropertyRemovals(
  previousBody: OpenApiObjectSchemaSignature,
  currentBody: OpenApiObjectSchemaSignature,
  schemaPath: string,
  context: ProducedSchemaDiffContext
): ContractDiffChange[] {
  const previousRequired = new Set(previousBody.required);
  const currentProperties = new Set(Object.keys(currentBody.properties));
  return Object.keys(previousBody.properties).flatMap((propertyName): ContractDiffChange[] =>
    previousRequired.has(propertyName) || currentProperties.has(propertyName)
      ? []
      : [{
          kind: 'removed_response_optional_property',
          classification: 'non-breaking',
          reason: `${context.contractLabel} optional property removed from current contract`,
          httpMethod: context.syntheticMethod,
          routePath: schemaPath,
          statusCode: 'schema',
          propertyName,
          schemaPath: `${schemaPath}.properties.${propertyName}`
        }]
  );
}

function classifyPropertyTypeChanges(
  previousBody: OpenApiObjectSchemaSignature,
  currentBody: OpenApiObjectSchemaSignature,
  schemaPath: string,
  context: ProducedSchemaDiffContext
): ContractDiffChange[] {
  return Object.entries(previousBody.properties).flatMap(([propertyName, previousProperty]): ContractDiffChange[] => {
    const currentProperty = currentBody.properties[propertyName];
    if (currentProperty === undefined || previousProperty.type === currentProperty.type) return [];
    if (typeWithoutNull(previousProperty.type) === typeWithoutNull(currentProperty.type)) return [];
    return [{
      kind: 'changed_response_property_type',
      classification: 'breaking',
      reason: `${context.contractLabel} property type changed in current contract`,
      httpMethod: context.syntheticMethod,
      routePath: schemaPath,
      statusCode: 'schema',
      propertyName,
      schemaPath: `${schemaPath}.properties.${propertyName}`,
      previousSchemaType: previousProperty.type,
      currentSchemaType: currentProperty.type
    }];
  });
}

function classifyNullableAdditions(
  previousBody: OpenApiObjectSchemaSignature,
  currentBody: OpenApiObjectSchemaSignature,
  schemaPath: string,
  context: ProducedSchemaDiffContext
): ContractDiffChange[] {
  return Object.entries(previousBody.properties).flatMap(([propertyName, previousProperty]): ContractDiffChange[] => {
    const currentProperty = currentBody.properties[propertyName];
    if (currentProperty === undefined || previousProperty.type.includes('null') || !currentProperty.type.includes('null')) {
      return [];
    }
    return [{
      kind: 'added_response_property_nullable',
      classification: 'breaking',
      reason: `${context.contractLabel} property now allows null in current contract`,
      httpMethod: context.syntheticMethod,
      routePath: schemaPath,
      statusCode: 'schema',
      propertyName,
      schemaPath: `${schemaPath}.properties.${propertyName}.type`,
      previousNullable: false,
      currentNullable: true
    }];
  });
}

function jsonSchemaEndpoints(compatibility: JsonSchemaCompatibilitySignature): ContractEndpoint[] {
  return compatibility.schemas.map((schema) => ({
    endpointId: `endpoint:json-schema:${schema.path}`,
    httpMethod: JSON_SCHEMA_SYNTHETIC_METHOD,
    routePath: schema.path
  }));
}

function typeWithoutNull(type: string): string {
  return type
    .split('|')
    .filter((item) => item !== 'null')
    .join('|');
}
