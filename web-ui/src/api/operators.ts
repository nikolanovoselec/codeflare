/** Operator administration wire contracts; secrets are mutation-only, never readback fields. */
export interface OperatorRegistration {
  operatorId: string;
  revision: number;
  enabled: boolean;
  approvedArtifactDigest: string | null;
}
export interface OperatorPolicyInput {
  schemaVersion: 1;
  networkHosts: string[];
  github: { repositories: string[]; methods: string[] };
  storage: { readPrefixes: string[]; writePrefixes: string[] };
  inference: { routeIds: string[]; defaultRouteId: string | null; reasoningLevels: string[];
    defaultReasoningLevel: string | null; inheritUserDefaults: boolean };
}
export interface OperatorDetails {
  registration: OperatorRegistration;
  endpoint: string | null;
  connectionSecretConfigured: boolean;
  webhookKeyConfigured: boolean;
  discoveredManifestJson: string | null;
  approvedManifestJson: string | null;
  policyJson: string | null;
}
function unavailable(): never { throw new Error('Operator administration client is not implemented'); }
export async function listOperators(): Promise<{ operators: OperatorRegistration[] }> { return unavailable(); }
export async function getOperator(_id: string): Promise<OperatorDetails> { return unavailable(); }
export async function registerOperator(_input: { endpoint: string; connectionSecret: string; policy: OperatorPolicyInput }): Promise<OperatorRegistration> { return unavailable(); }
export async function discoverOperator(_id: string): Promise<{ manifestJson: string }> { return unavailable(); }
export async function approveOperator(_id: string, _expectedRevision: number, _artifactDigest: string): Promise<OperatorRegistration> { return unavailable(); }
export async function setOperatorEnabled(_id: string, _expectedRevision: number, _enabled: boolean): Promise<OperatorRegistration> { return unavailable(); }
export async function setOperatorDistribution(_id: string, _expectedRevision: number, _endpoint: string, _connectionSecret: string): Promise<OperatorRegistration> { return unavailable(); }
export async function setOperatorPolicy(_id: string, _expectedRevision: number, _policy: OperatorPolicyInput): Promise<OperatorRegistration> { return unavailable(); }
export async function rotateOperatorWebhookKey(_id: string, _expectedRevision: number): Promise<{ registration: OperatorRegistration; key: string }> { return unavailable(); }
