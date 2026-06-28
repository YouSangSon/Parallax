import type { AsyncApiCompatibilitySignature } from '../asyncapi_compat.js';
import type { GraphqlCompatibilitySignature } from '../graphql_compat.js';
import type { OpenApiCompatibilitySignature } from '../openapi_compat.js';
import type { ProtobufCompatibilitySignature } from '../protobuf_compat.js';

export type ContractDiffClassification = 'breaking' | 'non-breaking' | 'unknown' | 'unchanged';

export type ContractDiffChangeKind =
  | 'removed_endpoint'
  | 'added_endpoint'
  | 'removed_response_status'
  | 'removed_response_required_property'
  | 'removed_response_optional_property'
  | 'changed_response_property_type'
  | 'removed_response_property_enum_value'
  | 'changed_response_property_format'
  | 'added_response_property_nullable'
  | 'added_request_required_property'
  | 'removed_request_property_enum_value'
  | 'changed_request_property_format'
  | 'changed_request_property_type'
  | 'unreadable_current_contract'
  | 'unparsed_current_contract'
  | 'changed_contract_without_endpoint_delta';

export type ContractDiffChange = {
  kind: ContractDiffChangeKind;
  classification: ContractDiffClassification;
  reason: string;
  httpMethod?: string;
  routePath?: string;
  previousEndpointId?: string;
  currentEndpointId?: string;
  statusCode?: string;
  propertyName?: string;
  schemaPath?: string;
  previousSchemaType?: string;
  currentSchemaType?: string;
  enumValue?: string;
  previousEnumValues?: readonly string[];
  currentEnumValues?: readonly string[];
  previousFormat?: string;
  currentFormat?: string;
  previousNullable?: boolean;
  currentNullable?: boolean;
};

export type ContractEndpoint = {
  endpointId?: string;
  httpMethod: string;
  routePath: string;
};

export type CurrentContractParse = {
  ok: boolean;
  endpoints: ContractEndpoint[];
  compatibility?: OpenApiCompatibilitySignature;
  protobufCompatibility?: ProtobufCompatibilitySignature;
  graphqlCompatibility?: GraphqlCompatibilitySignature;
  asyncApiCompatibility?: AsyncApiCompatibilitySignature;
  warning?: string;
};
