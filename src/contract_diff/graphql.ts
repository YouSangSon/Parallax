import {
  extractGraphqlCompatibility,
  GRAPHQL_COMPAT_ANALYZER_ID,
  GRAPHQL_COMPAT_SCHEMA_VERSION,
  type GraphqlArgumentSignature,
  type GraphqlCompatibilitySignature,
  type GraphqlFieldSignature,
  type GraphqlInputFieldSignature,
  type GraphqlInputTypeSignature,
  type GraphqlObjectTypeSignature,
  type GraphqlOperationSignature
} from '../graphql_compat.js';
import { parseJsonObject } from './shared.js';
import type { ContractDiffChange, CurrentContractParse } from './types.js';

export function classifyGraphqlCompatibilityChanges(
  previous: GraphqlCompatibilitySignature,
  current: GraphqlCompatibilitySignature
): ContractDiffChange[] {
  const previousOperations = graphqlOperationsByKey(previous.operations);
  const currentOperations = graphqlOperationsByKey(current.operations);
  const previousObjectTypes = graphqlObjectTypesByName(previous.objectTypes);
  const currentObjectTypes = graphqlObjectTypesByName(current.objectTypes);
  const previousInputTypes = graphqlInputTypesByName(previous.inputTypes);
  const currentInputTypes = graphqlInputTypesByName(current.inputTypes);
  const changes: ContractDiffChange[] = [];

  for (const [key, previousOperation] of previousOperations) {
    const currentOperation = currentOperations.get(key);
    if (!currentOperation) continue;
    changes.push(...classifyGraphqlOperationChanges(previousOperation, currentOperation));
    changes.push(...classifyGraphqlArgumentChanges(previousOperation, currentOperation));
    const previousResponseTypeName = graphqlNamedType(previousOperation.returnType);
    const currentResponseTypeName = graphqlNamedType(currentOperation.returnType);
    if (previousResponseTypeName === currentResponseTypeName) {
      changes.push(...classifyGraphqlResponseTypeChanges({
        operation: currentOperation,
        rootTypeName: previousResponseTypeName,
        previousObjectTypes,
        currentObjectTypes
      }));
    }
    changes.push(...classifyGraphqlInputTypeChanges({
      operation: currentOperation,
      previousArgs: previousOperation.args,
      currentArgs: currentOperation.args,
      previousInputTypes,
      currentInputTypes
    }));
  }

  return changes;
}

function classifyGraphqlOperationChanges(
  previousOperation: GraphqlOperationSignature,
  currentOperation: GraphqlOperationSignature
): ContractDiffChange[] {
  if (previousOperation.returnType === currentOperation.returnType) return [];
  return [{
    kind: 'changed_response_property_type',
    classification: 'breaking',
    reason: 'graphql root field return type changed in current schema',
    httpMethod: 'GRAPHQL',
    routePath: currentOperation.path,
    propertyName: '$',
    schemaPath: `response.${currentOperation.path}`,
    previousSchemaType: previousOperation.returnType,
    currentSchemaType: currentOperation.returnType
  }];
}

function classifyGraphqlArgumentChanges(
  previousOperation: GraphqlOperationSignature,
  currentOperation: GraphqlOperationSignature
): ContractDiffChange[] {
  const previousArgs = graphqlArgsByName(previousOperation.args);
  const changes: ContractDiffChange[] = [];
  for (const currentArg of currentOperation.args) {
    const previousArg = previousArgs.get(currentArg.name);
    if (!previousArg) {
      if (currentArg.required) {
        changes.push({
          kind: 'added_request_required_property',
          classification: 'breaking',
          reason: 'graphql required argument added to current schema',
          httpMethod: 'GRAPHQL',
          routePath: currentOperation.path,
          propertyName: currentArg.name,
          schemaPath: `request.${currentOperation.path}.args.${currentArg.name}`,
          currentSchemaType: currentArg.type
        });
      }
      continue;
    }
    if (!previousArg.required && currentArg.required) {
      changes.push({
        kind: 'added_request_required_property',
        classification: 'breaking',
        reason: 'graphql argument became required in current schema',
        httpMethod: 'GRAPHQL',
        routePath: currentOperation.path,
        propertyName: currentArg.name,
        schemaPath: `request.${currentOperation.path}.args.${currentArg.name}`,
        previousSchemaType: previousArg.type,
        currentSchemaType: currentArg.type
      });
    }
    if (previousArg.type !== currentArg.type) {
      changes.push({
        kind: 'changed_request_property_type',
        classification: 'breaking',
        reason: 'graphql argument type changed in current schema',
        httpMethod: 'GRAPHQL',
        routePath: currentOperation.path,
        propertyName: currentArg.name,
        schemaPath: `request.${currentOperation.path}.args.${currentArg.name}`,
        previousSchemaType: previousArg.type,
        currentSchemaType: currentArg.type
      });
    }
  }
  return changes;
}

function classifyGraphqlResponseTypeChanges(options: {
  operation: GraphqlOperationSignature;
  rootTypeName: string;
  previousObjectTypes: Map<string, GraphqlObjectTypeSignature>;
  currentObjectTypes: Map<string, GraphqlObjectTypeSignature>;
}): ContractDiffChange[] {
  const changes: ContractDiffChange[] = [];
  const visitedTypeNames = new Set<string>();
  collectGraphqlResponseTypeChanges(options.rootTypeName);
  return changes;

  function collectGraphqlResponseTypeChanges(typeName: string): void {
    if (visitedTypeNames.has(typeName)) return;
    visitedTypeNames.add(typeName);
    const previousType = options.previousObjectTypes.get(typeName);
    const currentType = options.currentObjectTypes.get(typeName);
    if (previousType === undefined || currentType === undefined) return;
    const currentFields = graphqlFieldsByName(currentType.fields);
    for (const previousField of previousType.fields) {
      const currentField = currentFields.get(previousField.name);
      const propertyName = `${previousType.name}.${previousField.name}`;
      const schemaPath = `response.${previousType.name}.fields.${previousField.name}`;
      if (!currentField) {
        changes.push({
          kind: 'removed_response_required_property',
          classification: 'breaking',
          reason: 'graphql response field removed from current schema',
          httpMethod: 'GRAPHQL',
          routePath: options.operation.path,
          propertyName,
          schemaPath
        });
        continue;
      }
      if (previousField.type !== currentField.type) {
        changes.push({
          kind: 'changed_response_property_type',
          classification: 'breaking',
          reason: 'graphql response field type changed in current schema',
          httpMethod: 'GRAPHQL',
          routePath: options.operation.path,
          propertyName,
          schemaPath,
          previousSchemaType: previousField.type,
          currentSchemaType: currentField.type
        });
      }
      const previousFieldTypeName = graphqlNamedType(previousField.type);
      const currentFieldTypeName = graphqlNamedType(currentField.type);
      if (previousFieldTypeName === currentFieldTypeName) {
        collectGraphqlResponseTypeChanges(previousFieldTypeName);
      }
    }
  }
}

function classifyGraphqlInputTypeChanges(options: {
  operation: GraphqlOperationSignature;
  previousArgs: readonly GraphqlArgumentSignature[];
  currentArgs: readonly GraphqlArgumentSignature[];
  previousInputTypes: Map<string, GraphqlInputTypeSignature>;
  currentInputTypes: Map<string, GraphqlInputTypeSignature>;
}): ContractDiffChange[] {
  const currentArgs = graphqlArgsByName(options.currentArgs);
  const changes: ContractDiffChange[] = [];
  for (const previousArg of options.previousArgs) {
    const currentArg = currentArgs.get(previousArg.name);
    if (!currentArg) continue;
    const previousInputTypeName = graphqlNamedType(previousArg.type);
    const currentInputTypeName = graphqlNamedType(currentArg.type);
    if (previousInputTypeName !== currentInputTypeName) continue;
    collectGraphqlInputTypeChanges(previousInputTypeName, currentArg, previousInputTypeName, new Set<string>());
  }
  return changes;

  function collectGraphqlInputTypeChanges(
    typeName: string,
    arg: GraphqlArgumentSignature,
    rootInputTypeName: string,
    visitedTypeNames: Set<string>
  ): void {
    if (visitedTypeNames.has(typeName)) return;
    visitedTypeNames.add(typeName);
    const previousInput = options.previousInputTypes.get(typeName);
    const currentInput = options.currentInputTypes.get(typeName);
    if (!previousInput || !currentInput) return;
    changes.push(...classifyGraphqlInputFields(options.operation, arg, rootInputTypeName, previousInput, currentInput));
    const currentFields = graphqlInputFieldsByName(currentInput.fields);
    for (const previousField of previousInput.fields) {
      const currentField = currentFields.get(previousField.name);
      if (!currentField) continue;
      const previousFieldTypeName = graphqlNamedType(previousField.type);
      const currentFieldTypeName = graphqlNamedType(currentField.type);
      if (previousFieldTypeName === currentFieldTypeName) {
        collectGraphqlInputTypeChanges(previousFieldTypeName, arg, rootInputTypeName, visitedTypeNames);
      }
    }
  }
}

function classifyGraphqlInputFields(
  operation: GraphqlOperationSignature,
  arg: GraphqlArgumentSignature,
  rootInputTypeName: string,
  previousInput: GraphqlInputTypeSignature,
  currentInput: GraphqlInputTypeSignature
): ContractDiffChange[] {
  const previousFields = graphqlInputFieldsByName(previousInput.fields);
  const changes: ContractDiffChange[] = [];
  for (const currentField of currentInput.fields) {
    const previousField = previousFields.get(currentField.name);
    const propertyName = `${currentInput.name}.${currentField.name}`;
    const schemaPath = graphqlInputFieldSchemaPath(operation, arg, rootInputTypeName, currentInput.name, currentField.name);
    if (!previousField) {
      if (currentField.required) {
        changes.push({
          kind: 'added_request_required_property',
          classification: 'breaking',
          reason: 'graphql required input field added to current schema',
          httpMethod: 'GRAPHQL',
          routePath: operation.path,
          propertyName,
          schemaPath,
          currentSchemaType: currentField.type
        });
      }
      continue;
    }
    if (!previousField.required && currentField.required) {
      changes.push({
        kind: 'added_request_required_property',
        classification: 'breaking',
        reason: 'graphql input field became required in current schema',
        httpMethod: 'GRAPHQL',
        routePath: operation.path,
        propertyName,
        schemaPath,
        previousSchemaType: previousField.type,
        currentSchemaType: currentField.type
      });
    }
    if (previousField.type !== currentField.type) {
      changes.push({
        kind: 'changed_request_property_type',
        classification: 'breaking',
        reason: 'graphql input field type changed in current schema',
        httpMethod: 'GRAPHQL',
        routePath: operation.path,
        propertyName,
        schemaPath,
        previousSchemaType: previousField.type,
        currentSchemaType: currentField.type
      });
    }
  }
  return changes;
}

function graphqlInputFieldSchemaPath(
  operation: GraphqlOperationSignature,
  arg: GraphqlArgumentSignature,
  rootInputTypeName: string,
  inputTypeName: string,
  fieldName: string
): string {
  const base = `request.${operation.path}.args.${arg.name}.${rootInputTypeName}.fields`;
  if (inputTypeName === rootInputTypeName) return `${base}.${fieldName}`;
  return `${base}.${inputTypeName}.${fieldName}`;
}

export function parseGraphqlCompatibility(
  compatibilityJson: string,
  warnings: string[]
): GraphqlCompatibilitySignature | undefined {
  const parsed = parseJsonObject(compatibilityJson);
  if (
    parsed?.analyzer === GRAPHQL_COMPAT_ANALYZER_ID &&
    parsed.schemaVersion !== undefined &&
    parsed.schemaVersion !== GRAPHQL_COMPAT_SCHEMA_VERSION
  ) {
    warnings.push(
      `indexed GraphQL compatibility baseline uses schemaVersion ${String(parsed.schemaVersion)}; reindex provider contract for schemaVersion ${GRAPHQL_COMPAT_SCHEMA_VERSION}`
    );
    return undefined;
  }
  if (
    parsed?.schemaVersion !== GRAPHQL_COMPAT_SCHEMA_VERSION ||
    parsed.analyzer !== GRAPHQL_COMPAT_ANALYZER_ID ||
    parsed.contractKind !== 'graphql' ||
    !Array.isArray(parsed.operations) ||
    !Array.isArray(parsed.objectTypes) ||
    !Array.isArray(parsed.inputTypes)
  ) {
    return undefined;
  }
  return parsed as GraphqlCompatibilitySignature;
}

function graphqlOperationsByKey(
  operations: readonly GraphqlOperationSignature[]
): Map<string, GraphqlOperationSignature> {
  const byKey = new Map<string, GraphqlOperationSignature>();
  for (const operation of operations) {
    byKey.set(graphqlOperationKey(operation), operation);
  }
  return byKey;
}

function graphqlOperationKey(operation: GraphqlOperationSignature): string {
  return `${operation.rootType}.${operation.field}`;
}

function graphqlObjectTypesByName(
  objectTypes: readonly GraphqlObjectTypeSignature[]
): Map<string, GraphqlObjectTypeSignature> {
  const byName = new Map<string, GraphqlObjectTypeSignature>();
  for (const type of objectTypes) {
    byName.set(type.name, type);
  }
  return byName;
}

function graphqlInputTypesByName(
  inputTypes: readonly GraphqlInputTypeSignature[]
): Map<string, GraphqlInputTypeSignature> {
  const byName = new Map<string, GraphqlInputTypeSignature>();
  for (const type of inputTypes) {
    byName.set(type.name, type);
  }
  return byName;
}

function graphqlArgsByName(args: readonly GraphqlArgumentSignature[]): Map<string, GraphqlArgumentSignature> {
  const byName = new Map<string, GraphqlArgumentSignature>();
  for (const arg of args) {
    byName.set(arg.name, arg);
  }
  return byName;
}

function graphqlFieldsByName(fields: readonly GraphqlFieldSignature[]): Map<string, GraphqlFieldSignature> {
  const byName = new Map<string, GraphqlFieldSignature>();
  for (const field of fields) {
    byName.set(field.name, field);
  }
  return byName;
}

function graphqlInputFieldsByName(
  fields: readonly GraphqlInputFieldSignature[]
): Map<string, GraphqlInputFieldSignature> {
  const byName = new Map<string, GraphqlInputFieldSignature>();
  for (const field of fields) {
    byName.set(field.name, field);
  }
  return byName;
}

function graphqlNamedType(typeName: string): string {
  return typeName.replace(/[!\[\]]/g, '');
}

export function parseCurrentGraphqlContract(content: string): CurrentContractParse {
  const compatibility = extractGraphqlCompatibility(content);
  if (compatibility === undefined) {
    return {
      ok: false,
      endpoints: [],
      warning: 'current GraphQL contract could not be parsed: no root operations or types found'
    };
  }
  return {
    ok: true,
    endpoints: compatibility.operations.map((operation) => ({
      endpointId: `endpoint:graphql:${operation.path}`,
      httpMethod: 'GRAPHQL',
      routePath: operation.path
    })),
    graphqlCompatibility: compatibility
  };
}
