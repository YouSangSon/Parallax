import { parse as parseYaml } from 'yaml';

export const ASYNCAPI_COMPAT_ANALYZER_ID = 'asyncapi-compat-v0';
export const ASYNCAPI_COMPAT_SCHEMA_VERSION = 1;

export type AsyncApiCompatibilitySignature = {
  readonly schemaVersion: typeof ASYNCAPI_COMPAT_SCHEMA_VERSION;
  readonly analyzer: typeof ASYNCAPI_COMPAT_ANALYZER_ID;
  readonly contractKind: 'asyncapi';
  readonly operations: readonly AsyncApiOperationSignature[];
  readonly messages: readonly AsyncApiMessageSignature[];
};

export type AsyncApiOperationSignature = {
  readonly action: string;
  readonly channelId: string;
  readonly address: string;
  readonly messageIds: readonly string[];
};

export type AsyncApiMessageSignature = {
  readonly id: string;
  readonly payload?: AsyncApiObjectSchemaSignature;
};

export type AsyncApiObjectSchemaSignature = {
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, AsyncApiPropertySignature>>;
};

export type AsyncApiPropertySignature = {
  readonly type: string;
};

export type AsyncApiYamlCompatibilityParse =
  | {
      readonly ok: true;
      readonly compatibility?: AsyncApiCompatibilitySignature;
    }
  | {
      readonly ok: false;
      readonly warning: string;
    };

export type AsyncApiJsonCompatibilityParse =
  | {
      readonly ok: true;
      readonly compatibility?: AsyncApiCompatibilitySignature;
    }
  | {
      readonly ok: false;
      readonly warning: string;
    };

const ASYNCAPI_V2_ACTIONS = ['publish', 'subscribe'] as const;
const ASYNCAPI_V3_ACTIONS = new Set(['send', 'receive']);
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

type AsyncApiCompatibilityParseResult =
  | {
      readonly kind: 'compatible';
      readonly compatibility: AsyncApiCompatibilitySignature;
    }
  | {
      readonly kind: 'absent';
    }
  | {
      readonly kind: 'invalid';
      readonly reason: string;
    };

type AsyncApiOperationParseResult =
  | {
      readonly kind: 'ok';
      readonly operations: readonly AsyncApiOperationSignature[];
    }
  | {
      readonly kind: 'invalid';
      readonly reason: string;
    };

export function extractAsyncApiJsonCompatibility(content: string): AsyncApiCompatibilitySignature | undefined {
  const result = parseAsyncApiJsonCompatibility(content);
  return result.ok ? result.compatibility : undefined;
}

export function extractAsyncApiYamlCompatibility(content: string): AsyncApiCompatibilitySignature | undefined {
  const result = parseAsyncApiYamlCompatibility(content);
  return result.ok ? result.compatibility : undefined;
}

export function parseAsyncApiJsonCompatibility(content: string): AsyncApiJsonCompatibilityParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    return {
      ok: false,
      warning: `current AsyncAPI JSON could not be parsed: ${errorMessage(error)}`
    };
  }
  const result = extractAsyncApiCompatibilityResult(parsed);
  if (result.kind === 'invalid') {
    return {
      ok: false,
      warning: `current AsyncAPI JSON could not be parsed: ${result.reason}`
    };
  }
  return {
    ok: true,
    ...(result.kind === 'compatible' ? { compatibility: result.compatibility } : {})
  };
}

export function parseAsyncApiYamlCompatibility(content: string): AsyncApiYamlCompatibilityParse {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (error) {
    return {
      ok: false,
      warning: `current AsyncAPI YAML could not be parsed: ${errorMessage(error)}`
    };
  }
  const result = extractAsyncApiCompatibilityResult(parsed);
  if (result.kind === 'invalid') {
    return {
      ok: false,
      warning: `current AsyncAPI YAML could not be parsed: ${result.reason}`
    };
  }
  return {
    ok: true,
    ...(result.kind === 'compatible' ? { compatibility: result.compatibility } : {})
  };
}

export function extractAsyncApiCompatibility(parsed: unknown): AsyncApiCompatibilitySignature | undefined {
  const result = extractAsyncApiCompatibilityResult(parsed);
  return result.kind === 'compatible' ? result.compatibility : undefined;
}

function extractAsyncApiCompatibilityResult(parsed: unknown): AsyncApiCompatibilityParseResult {
  if (!isRecord(parsed)) return { kind: 'absent' };
  const marker = parsed.asyncapi;
  if (typeof marker !== 'string' || marker.length === 0) return { kind: 'absent' };
  if (parsed.channels !== undefined && !isRecord(parsed.channels)) {
    return {
      kind: 'invalid',
      reason: 'channels must be an object'
    };
  }
  const channels = isRecord(parsed.channels) ? parsed.channels : {};
  const parsedOperations = parsed.operations;
  let operationResult: AsyncApiOperationParseResult;
  if (parsedOperations !== undefined) {
    if (!isRecord(parsedOperations)) {
      return {
        kind: 'invalid',
        reason: 'operations must be an object'
      };
    }
    operationResult = asyncApiV3Operations(parsed, channels, parsedOperations);
  } else {
    operationResult = asyncApiV2Operations(parsed, channels);
  }
  if (operationResult.kind === 'invalid') return operationResult;
  const operations = operationResult.operations;
  const messages = asyncApiMessages(parsed, channels, operations);
  if (operations.length === 0 && messages.length === 0 && parsed.channels === undefined && parsed.operations === undefined) {
    return { kind: 'absent' };
  }
  return {
    kind: 'compatible',
    compatibility: {
      schemaVersion: ASYNCAPI_COMPAT_SCHEMA_VERSION,
      analyzer: ASYNCAPI_COMPAT_ANALYZER_ID,
      contractKind: 'asyncapi',
      operations,
      messages
    }
  };
}

function asyncApiV3Operations(
  root: Record<string, unknown>,
  channels: Record<string, unknown>,
  operationsObject: Record<string, unknown>
): AsyncApiOperationParseResult {
  const operations: AsyncApiOperationSignature[] = [];
  for (const [operationId, operationValue] of Object.entries(operationsObject)) {
    const operation = resolveMaybeRef(root, operationValue);
    if (!isRecord(operation)) {
      return {
        kind: 'invalid',
        reason: `operation must be an object for ${operationId}`
      };
    }
    const action = stringValue(operation.action)?.toLowerCase();
    if (!action) {
      return {
        kind: 'invalid',
        reason: `operation action must be a string for ${operationId}`
      };
    }
    if (!ASYNCAPI_V3_ACTIONS.has(action)) {
      return {
        kind: 'invalid',
        reason: `operation action must be send or receive for ${operationId}`
      };
    }
    const channelRef = refString(operation.channel);
    const channelId = channelRef === undefined ? operationId : jsonPointerTail(channelRef);
    const channel = resolveMaybeRef(root, operation.channel);
    if (!isRecord(channel)) {
      return {
        kind: 'invalid',
        reason: `operation channel must resolve to an object for ${operationId}`
      };
    }
    const address = isRecord(channel) && typeof channel.address === 'string'
      ? channel.address
      : channelId;
    operations.push({
      action,
      channelId,
      address,
      messageIds: operationMessageIds(root, operation, channelId, isRecord(channel) ? channel : undefined)
    });
  }
  return {
    kind: 'ok',
    operations: operations.sort(compareOperations)
  };

  function operationMessageIds(
    rootDocument: Record<string, unknown>,
    operation: Record<string, unknown>,
    channelId: string,
    channel: Record<string, unknown> | undefined
  ): string[] {
    const ids = messageIdsFromValue(rootDocument, operation.messages);
    if (ids.length > 0) return uniqueSorted(ids);
    const channelMessages = channel?.messages;
    if (isRecord(channelMessages)) return uniqueSorted(Object.keys(channelMessages));
    const channelValue = channels[channelId];
    const indexedChannel = resolveMaybeRef(rootDocument, channelValue);
    if (isRecord(indexedChannel) && isRecord(indexedChannel.messages)) {
      return uniqueSorted(Object.keys(indexedChannel.messages));
    }
    return [];
  }
}

function asyncApiV2Operations(
  root: Record<string, unknown>,
  channels: Record<string, unknown>
): AsyncApiOperationParseResult {
  const operations: AsyncApiOperationSignature[] = [];
  for (const [channelId, channelValue] of Object.entries(channels)) {
    const channel = resolveMaybeRef(root, channelValue);
    if (!isRecord(channel)) {
      return {
        kind: 'invalid',
        reason: `channel must be an object for ${channelId}`
      };
    }
    for (const action of ASYNCAPI_V2_ACTIONS) {
      if (channel[action] === undefined) continue;
      const operation = resolveMaybeRef(root, channel[action]);
      if (!isRecord(operation)) {
        return {
          kind: 'invalid',
          reason: `${action} operation must be an object for ${channelId}`
        };
      }
      operations.push({
        action,
        channelId,
        address: channelId,
        messageIds: uniqueSorted(messageIdsFromValue(root, operation.message))
      });
    }
  }
  return {
    kind: 'ok',
    operations: operations.sort(compareOperations)
  };
}

function asyncApiMessages(
  root: Record<string, unknown>,
  channels: Record<string, unknown>,
  operations: readonly AsyncApiOperationSignature[]
): AsyncApiMessageSignature[] {
  const messageValues = new Map<string, unknown>();
  for (const operation of operations) {
    for (const messageId of operation.messageIds) {
      const messageValue = messageValueForOperation(root, channels, operation, messageId);
      if (messageValue !== undefined) messageValues.set(messageId, messageValue);
    }
  }

  const componentMessages = componentMessagesObject(root);
  if (componentMessages !== undefined) {
    for (const [messageId, messageValue] of Object.entries(componentMessages)) {
      if (operations.length === 0 || messageValues.has(messageId)) messageValues.set(messageId, messageValue);
    }
  }

  return [...messageValues.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, messageValue]) => {
      const message = resolveMaybeRef(root, messageValue);
      const payload = isRecord(message)
        ? objectSchemaSignature(root, message.payload, new Set())
        : undefined;
      return {
        id,
        ...(payload !== undefined ? { payload } : {})
      };
    });
}

function messageValueForOperation(
  root: Record<string, unknown>,
  channels: Record<string, unknown>,
  operation: AsyncApiOperationSignature,
  messageId: string
): unknown {
  const channel = resolveMaybeRef(root, channels[operation.channelId]);
  if (isRecord(channel) && isRecord(channel.messages) && channel.messages[messageId] !== undefined) {
    return channel.messages[messageId];
  }
  const componentMessages = componentMessagesObject(root);
  if (componentMessages?.[messageId] !== undefined) return componentMessages[messageId];
  return undefined;
}

function messageIdsFromValue(root: Record<string, unknown>, value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => messageIdsFromValue(root, item));
  const ref = refString(value);
  if (ref !== undefined) return [jsonPointerTail(ref)];
  const resolved = resolveMaybeRef(root, value);
  if (!isRecord(resolved)) return [];
  if (Array.isArray(resolved.oneOf)) return resolved.oneOf.flatMap((item) => messageIdsFromValue(root, item));
  if (Array.isArray(resolved.anyOf)) return resolved.anyOf.flatMap((item) => messageIdsFromValue(root, item));
  const id = stringValue(resolved.messageId) ?? stringValue(resolved.name) ?? stringValue(resolved.title);
  return id === undefined ? [] : [id];
}

function componentMessagesObject(root: Record<string, unknown>): Record<string, unknown> | undefined {
  const components = root.components;
  if (!isRecord(components) || !isRecord(components.messages)) return undefined;
  return components.messages;
}

function objectSchemaSignature(
  root: Record<string, unknown>,
  schemaValue: unknown,
  seenRefs: Set<string>
): AsyncApiObjectSchemaSignature | undefined {
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
      [...builder.properties.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
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
    .map(decodeJsonPointerSegment);
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

function refString(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.$ref !== 'string' || !value.$ref.startsWith('#/')) return undefined;
  return value.$ref;
}

function jsonPointerTail(ref: string): string {
  return decodeJsonPointerSegment(ref.split('/').at(-1) ?? ref);
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function compareOperations(left: AsyncApiOperationSignature, right: AsyncApiOperationSignature): number {
  return left.address.localeCompare(right.address) ||
    left.action.localeCompare(right.action) ||
    left.channelId.localeCompare(right.channelId);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
