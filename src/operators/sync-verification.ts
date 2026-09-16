/** Parent-established operation scope; never accept an agent-selected bucket or prefix. */
export interface OperatorSyncExpectation {
  activityId: string;
  sessionId: string;
  operationId: string;
  requestDigest: string;
  policyDigest: string;
  manifestDigest: string;
  prefix: string;
  deadline: number;
}

/** Adapter must enforce maxBytes while reading, before materializing the object. */
export type OperatorSyncReader = (key: string, maxBytes: number) => Promise<Uint8Array | null>;

/** REQ-OPERATOR-005 byte verification boundary under TDD; no upload/lifecycle wiring. */
export async function verifyOperatorSync(
  _expected: OperatorSyncExpectation,
  _read: OperatorSyncReader,
): Promise<{ manifestDigest: string; filesVerified: number; bytesVerified: number }> {
  throw new Error('Operator sync verification is not implemented');
}
