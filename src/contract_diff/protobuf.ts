import {
  extractProtobufCompatibility,
  PROTOBUF_COMPAT_ANALYZER_ID,
  PROTOBUF_COMPAT_SCHEMA_VERSION,
  type ProtobufCompatibilitySignature,
  type ProtobufFieldSignature,
  type ProtobufMessageSignature,
  type ProtobufOperationSignature
} from '../protobuf_compat.js';
import { parseJsonObject } from './shared.js';
import type { ContractDiffChange, CurrentContractParse } from './types.js';

export function classifyProtobufCompatibilityChanges(
  previous: ProtobufCompatibilitySignature,
  current: ProtobufCompatibilitySignature
): ContractDiffChange[] {
  const previousOperations = protobufOperationsByKey(previous.operations);
  const currentOperations = protobufOperationsByKey(current.operations);
  const previousMessages = protobufMessagesByName(previous.messages);
  const currentMessages = protobufMessagesByName(current.messages);
  const changes: ContractDiffChange[] = [];

  for (const [key, previousOperation] of previousOperations) {
    const currentOperation = currentOperations.get(key);
    if (!currentOperation) continue;
    changes.push(...classifyProtobufRpcTypeChanges(previousOperation, currentOperation));
    changes.push(...classifyProtobufMessageChanges({
      operation: currentOperation,
      previousMessage: previousMessages.get(previousOperation.requestType),
      currentMessage: currentMessages.get(currentOperation.requestType),
      direction: 'request'
    }));
    changes.push(...classifyProtobufMessageChanges({
      operation: currentOperation,
      previousMessage: previousMessages.get(previousOperation.responseType),
      currentMessage: currentMessages.get(currentOperation.responseType),
      direction: 'response'
    }));
  }

  return changes;
}

function classifyProtobufRpcTypeChanges(
  previousOperation: ProtobufOperationSignature,
  currentOperation: ProtobufOperationSignature
): ContractDiffChange[] {
  const changes: ContractDiffChange[] = [];
  if (
    previousOperation.requestType !== currentOperation.requestType ||
    previousOperation.requestStream !== currentOperation.requestStream
  ) {
    changes.push({
      kind: 'changed_request_property_type',
      classification: 'breaking',
      reason: 'protobuf RPC request type changed in current contract',
      httpMethod: 'RPC',
      routePath: currentOperation.path,
      propertyName: '$',
      schemaPath: 'request',
      previousSchemaType: protobufRpcType(previousOperation.requestType, previousOperation.requestStream),
      currentSchemaType: protobufRpcType(currentOperation.requestType, currentOperation.requestStream)
    });
  }
  if (
    previousOperation.responseType !== currentOperation.responseType ||
    previousOperation.responseStream !== currentOperation.responseStream
  ) {
    changes.push({
      kind: 'changed_response_property_type',
      classification: 'breaking',
      reason: 'protobuf RPC response type changed in current contract',
      httpMethod: 'RPC',
      routePath: currentOperation.path,
      propertyName: '$',
      schemaPath: 'response',
      previousSchemaType: protobufRpcType(previousOperation.responseType, previousOperation.responseStream),
      currentSchemaType: protobufRpcType(currentOperation.responseType, currentOperation.responseStream)
    });
  }
  return changes;
}

function classifyProtobufMessageChanges(options: {
  operation: ProtobufOperationSignature;
  previousMessage: ProtobufMessageSignature | undefined;
  currentMessage: ProtobufMessageSignature | undefined;
  direction: 'request' | 'response';
}): ContractDiffChange[] {
  if (options.previousMessage === undefined || options.currentMessage === undefined) return [];
  const currentFields = protobufFieldsByNumber(options.currentMessage.fields);
  const changes: ContractDiffChange[] = [];
  for (const previousField of options.previousMessage.fields) {
    const currentField = currentFields.get(previousField.number);
    const propertyName = protobufFieldDisplayName(options.previousMessage, previousField);
    const schemaPath = `${options.direction}.${shortProtobufTypeName(options.previousMessage.name)}.fields.${previousField.number}`;
    if (!currentField) {
      changes.push({
        kind: options.direction === 'request' ? 'changed_request_property_type' : 'removed_response_required_property',
        classification: 'breaking',
        reason: options.direction === 'request'
          ? 'protobuf request field removed from current contract'
          : 'protobuf response field removed from current contract',
        httpMethod: 'RPC',
        routePath: options.operation.path,
        propertyName,
        schemaPath
      });
      continue;
    }
    const previousType = protobufFieldType(previousField);
    const currentType = protobufFieldType(currentField);
    if (previousType === currentType && previousField.name === currentField.name) continue;
    changes.push({
      kind: options.direction === 'request' ? 'changed_request_property_type' : 'changed_response_property_type',
      classification: 'breaking',
      reason: options.direction === 'request'
        ? 'protobuf request field type changed in current contract'
        : 'protobuf response field type changed in current contract',
      httpMethod: 'RPC',
      routePath: options.operation.path,
      propertyName,
      schemaPath,
      previousSchemaType: previousType,
      currentSchemaType: currentType
    });
  }
  return changes;
}

export function parseProtobufCompatibility(
  compatibilityJson: string,
  warnings: string[]
): ProtobufCompatibilitySignature | undefined {
  const parsed = parseJsonObject(compatibilityJson);
  if (
    parsed?.analyzer === PROTOBUF_COMPAT_ANALYZER_ID &&
    parsed.schemaVersion !== undefined &&
    parsed.schemaVersion !== PROTOBUF_COMPAT_SCHEMA_VERSION
  ) {
    warnings.push(
      `indexed Protobuf compatibility baseline uses schemaVersion ${String(parsed.schemaVersion)}; reindex provider contract for schemaVersion ${PROTOBUF_COMPAT_SCHEMA_VERSION}`
    );
    return undefined;
  }
  if (
    parsed?.schemaVersion !== PROTOBUF_COMPAT_SCHEMA_VERSION ||
    parsed.analyzer !== PROTOBUF_COMPAT_ANALYZER_ID ||
    parsed.contractKind !== 'protobuf' ||
    !Array.isArray(parsed.operations) ||
    !Array.isArray(parsed.messages)
  ) {
    return undefined;
  }
  return parsed as ProtobufCompatibilitySignature;
}

function protobufOperationsByKey(
  operations: readonly ProtobufOperationSignature[]
): Map<string, ProtobufOperationSignature> {
  const byKey = new Map<string, ProtobufOperationSignature>();
  for (const operation of operations) {
    byKey.set(protobufOperationKey(operation), operation);
  }
  return byKey;
}

function protobufOperationKey(operation: ProtobufOperationSignature): string {
  return `${operation.service}.${operation.rpc}`;
}

function protobufMessagesByName(
  messages: readonly ProtobufMessageSignature[]
): Map<string, ProtobufMessageSignature> {
  const byName = new Map<string, ProtobufMessageSignature>();
  for (const message of messages) {
    byName.set(message.name, message);
  }
  return byName;
}

function protobufFieldsByNumber(
  fields: readonly ProtobufFieldSignature[]
): Map<number, ProtobufFieldSignature> {
  const byNumber = new Map<number, ProtobufFieldSignature>();
  for (const field of fields) {
    byNumber.set(field.number, field);
  }
  return byNumber;
}

function protobufRpcType(typeName: string, stream: boolean): string {
  return stream ? `stream ${typeName}` : typeName;
}

function protobufFieldType(field: ProtobufFieldSignature): string {
  return field.label === 'singular' ? field.type : `${field.label} ${field.type}`;
}

function protobufFieldDisplayName(message: ProtobufMessageSignature, field: ProtobufFieldSignature): string {
  return `${shortProtobufTypeName(message.name)}.${field.name}#${field.number}`;
}

function shortProtobufTypeName(typeName: string): string {
  return typeName.split('.').at(-1) ?? typeName;
}

export function parseCurrentProtobufContract(content: string): CurrentContractParse {
  const compatibility = extractProtobufCompatibility(content);
  if (compatibility === undefined) {
    return {
      ok: false,
      endpoints: [],
      warning: 'current Protobuf contract could not be parsed: no services or messages found'
    };
  }
  return {
    ok: true,
    endpoints: compatibility.operations.map((operation) => ({
      endpointId: `endpoint:protobuf:${operation.service}.${operation.rpc}`,
      httpMethod: 'RPC',
      routePath: operation.path
    })),
    protobufCompatibility: compatibility
  };
}
