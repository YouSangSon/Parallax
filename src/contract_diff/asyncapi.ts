import {
  ASYNCAPI_COMPAT_ANALYZER_ID,
  ASYNCAPI_COMPAT_SCHEMA_VERSION,
  parseAsyncApiJsonCompatibility,
  parseAsyncApiYamlCompatibility,
  type AsyncApiCompatibilitySignature,
  type AsyncApiMessageSignature,
  type AsyncApiObjectSchemaSignature,
  type AsyncApiOperationSignature
} from '../asyncapi_compat.js';
import { endpointKey, parseJsonObject } from './shared.js';
import type { ContractDiffChange, CurrentContractParse } from './types.js';

export function classifyAsyncApiCompatibilityChanges(
  previous: AsyncApiCompatibilitySignature,
  current: AsyncApiCompatibilitySignature
): ContractDiffChange[] {
  const previousOperations = asyncApiOperationsByKey(previous.operations);
  const currentOperations = asyncApiOperationsByKey(current.operations);
  const previousMessages = asyncApiMessagesById(previous.messages);
  const currentMessages = asyncApiMessagesById(current.messages);
  const changes: ContractDiffChange[] = [];
  for (const [key, previousOperation] of previousOperations) {
    const currentOperation = currentOperations.get(key);
    if (!currentOperation) continue;
    const currentMessageIds = new Set(currentOperation.messageIds);
    for (const previousMessageId of previousOperation.messageIds) {
      if (!currentMessageIds.has(previousMessageId)) {
        changes.push({
          kind: 'removed_response_required_property',
          classification: 'breaking',
          reason: 'asyncapi operation message removed from current contract',
          httpMethod: currentOperation.action.toUpperCase(),
          routePath: currentOperation.address,
          propertyName: previousMessageId,
          schemaPath: `messages.${previousMessageId}`
        });
        continue;
      }
      changes.push(...classifyAsyncApiPayloadChanges({
        operation: currentOperation,
        previousMessage: previousMessages.get(previousMessageId),
        currentMessage: currentMessages.get(previousMessageId)
      }));
    }
  }
  return changes;
}

function classifyAsyncApiPayloadChanges(options: {
  operation: AsyncApiOperationSignature;
  previousMessage: AsyncApiMessageSignature | undefined;
  currentMessage: AsyncApiMessageSignature | undefined;
}): ContractDiffChange[] {
  const previousPayload = options.previousMessage?.payload;
  if (options.previousMessage === undefined || previousPayload === undefined) return [];
  const currentPayload = options.currentMessage?.payload;
  const messageId = options.previousMessage.id;
  const method = options.operation.action.toUpperCase();
  const routePath = options.operation.address;
  if (currentPayload === undefined) {
    return [{
      kind: 'changed_response_property_type',
      classification: 'breaking',
      reason: 'asyncapi message payload removed from current contract',
      httpMethod: method,
      routePath,
      propertyName: `${messageId}.$`,
      schemaPath: `messages.${messageId}.payload`
    }];
  }

  const changes: ContractDiffChange[] = [];
  changes.push(...classifyAsyncApiRemovedPayloadFields(messageId, method, routePath, previousPayload, currentPayload));
  changes.push(...classifyAsyncApiPayloadTypeChanges(messageId, method, routePath, previousPayload, currentPayload));
  changes.push(...classifyAsyncApiAddedRequiredPayloadFields(messageId, method, routePath, previousPayload, currentPayload));
  return changes;
}

function classifyAsyncApiRemovedPayloadFields(
  messageId: string,
  method: string,
  routePath: string,
  previousPayload: AsyncApiObjectSchemaSignature,
  currentPayload: AsyncApiObjectSchemaSignature
): ContractDiffChange[] {
  const changes: ContractDiffChange[] = [];
  for (const propertyName of Object.keys(previousPayload.properties).sort((left, right) => left.localeCompare(right))) {
    if (currentPayload.properties[propertyName] !== undefined) continue;
    changes.push({
      kind: 'removed_response_required_property',
      classification: 'breaking',
      reason: 'asyncapi message payload field removed from current contract',
      httpMethod: method,
      routePath,
      propertyName: `${messageId}.${propertyName}`,
      schemaPath: `messages.${messageId}.payload.properties.${propertyName}`
    });
  }
  return changes;
}

function classifyAsyncApiPayloadTypeChanges(
  messageId: string,
  method: string,
  routePath: string,
  previousPayload: AsyncApiObjectSchemaSignature,
  currentPayload: AsyncApiObjectSchemaSignature
): ContractDiffChange[] {
  const changes: ContractDiffChange[] = [];
  for (const [propertyName, previousProperty] of Object.entries(previousPayload.properties)) {
    const currentProperty = currentPayload.properties[propertyName];
    if (currentProperty === undefined || currentProperty.type === previousProperty.type) continue;
    changes.push({
      kind: 'changed_response_property_type',
      classification: 'breaking',
      reason: 'asyncapi message payload field type changed in current contract',
      httpMethod: method,
      routePath,
      propertyName: `${messageId}.${propertyName}`,
      schemaPath: `messages.${messageId}.payload.properties.${propertyName}`,
      previousSchemaType: previousProperty.type,
      currentSchemaType: currentProperty.type
    });
  }
  return changes;
}

function classifyAsyncApiAddedRequiredPayloadFields(
  messageId: string,
  method: string,
  routePath: string,
  previousPayload: AsyncApiObjectSchemaSignature,
  currentPayload: AsyncApiObjectSchemaSignature
): ContractDiffChange[] {
  const previousRequired = new Set(previousPayload.required);
  const changes: ContractDiffChange[] = [];
  for (const propertyName of currentPayload.required) {
    if (previousRequired.has(propertyName)) continue;
    changes.push({
      kind: 'added_request_required_property',
      classification: 'breaking',
      reason: 'asyncapi message required payload field added to current contract',
      httpMethod: method,
      routePath,
      propertyName: `${messageId}.${propertyName}`,
      schemaPath: `messages.${messageId}.payload.required.${propertyName}`,
      ...(currentPayload.properties[propertyName] !== undefined
        ? { currentSchemaType: currentPayload.properties[propertyName].type }
        : {})
    });
  }
  return changes;
}

export function parseAsyncApiCompatibility(
  compatibilityJson: string,
  warnings: string[]
): AsyncApiCompatibilitySignature | undefined {
  const parsed = parseJsonObject(compatibilityJson);
  if (
    parsed?.analyzer === ASYNCAPI_COMPAT_ANALYZER_ID &&
    parsed.schemaVersion !== undefined &&
    parsed.schemaVersion !== ASYNCAPI_COMPAT_SCHEMA_VERSION
  ) {
    warnings.push(
      `indexed AsyncAPI compatibility baseline uses schemaVersion ${String(parsed.schemaVersion)}; reindex provider contract for schemaVersion ${ASYNCAPI_COMPAT_SCHEMA_VERSION}`
    );
    return undefined;
  }
  if (
    parsed?.schemaVersion !== ASYNCAPI_COMPAT_SCHEMA_VERSION ||
    parsed.analyzer !== ASYNCAPI_COMPAT_ANALYZER_ID ||
    parsed.contractKind !== 'asyncapi' ||
    !Array.isArray(parsed.operations) ||
    !Array.isArray(parsed.messages)
  ) {
    return undefined;
  }
  return parsed as AsyncApiCompatibilitySignature;
}

function asyncApiOperationsByKey(
  operations: readonly AsyncApiOperationSignature[]
): Map<string, AsyncApiOperationSignature> {
  const byKey = new Map<string, AsyncApiOperationSignature>();
  for (const operation of operations) {
    byKey.set(endpointKey(operation.action, operation.address), operation);
  }
  return byKey;
}

function asyncApiMessagesById(
  messages: readonly AsyncApiMessageSignature[]
): Map<string, AsyncApiMessageSignature> {
  const byId = new Map<string, AsyncApiMessageSignature>();
  for (const message of messages) {
    byId.set(message.id, message);
  }
  return byId;
}

export function parseCurrentAsyncApiContract(content: string, contractPath: string): CurrentContractParse {
  let compatibility: AsyncApiCompatibilitySignature | undefined;
  if (contractPath.toLowerCase().endsWith('.json')) {
    const parsed = parseAsyncApiJsonCompatibility(content);
    if (!parsed.ok) {
      return {
        ok: false,
        endpoints: [],
        warning: parsed.warning
      };
    }
    compatibility = parsed.compatibility;
  } else {
    const parsed = parseAsyncApiYamlCompatibility(content);
    if (!parsed.ok) {
      return {
        ok: false,
        endpoints: [],
        warning: parsed.warning
      };
    }
    compatibility = parsed.compatibility;
  }
  if (compatibility === undefined) {
    return {
      ok: false,
      endpoints: [],
      warning: 'current AsyncAPI contract could not be parsed: no operations or messages found'
    };
  }
  return {
    ok: true,
    endpoints: compatibility.operations.map((operation) => ({
      endpointId: `endpoint:asyncapi:${endpointKey(operation.action, operation.address)}`,
      httpMethod: operation.action.toUpperCase(),
      routePath: operation.address
    })),
    asyncApiCompatibility: compatibility
  };
}
