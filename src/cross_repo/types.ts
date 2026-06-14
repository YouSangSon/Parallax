export type CrossRepoEventTopology = {
  providerAction: string;
  counterpartyRole: 'consumer' | 'producer' | 'unknown';
  pattern: string;
};

export type ConsumerEvidence = {
  snippet: string;
  eventTopology?: CrossRepoEventTopology;
};
