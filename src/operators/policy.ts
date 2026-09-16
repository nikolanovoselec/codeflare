/** Registration restrictions only; never an identity, bucket selection or permission grant. */
export interface OperatorPolicy {
  schemaVersion: 1;
  networkHosts: string[];
  github: { repositories: string[]; methods: string[] };
  storage: { readPrefixes: string[]; writePrefixes: string[] };
  inference: {
    routeIds: string[];
    defaultRouteId: string | null;
    reasoningLevels: string[];
    defaultReasoningLevel: string | null;
    inheritUserDefaults: boolean;
  };
}

/** Validate bounded untrusted registration restrictions; empty lists deny access. */
export function parseOperatorPolicy(_input: unknown): OperatorPolicy {
  throw new Error('Operator registration policy validation is not implemented');
}
