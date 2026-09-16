/** Parent-generated context; separates operators/activities and secret purposes. */
export interface OperatorSecretContext {
  purpose: 'connection' | 'human-access' | 'webhook';
  recordId: string;
}

/** REQ-OPERATOR-002 protected-secret boundary under behavioral TDD. */
export async function sealOperatorSecret(
  _plaintext: string,
  _env: { ENCRYPTION_KEY?: string },
  _context: OperatorSecretContext,
): Promise<string> {
  throw new Error('Operator secret protection is not implemented');
}

export async function openOperatorSecret(
  _ciphertext: string,
  _env: { ENCRYPTION_KEY?: string },
  _context: OperatorSecretContext,
): Promise<string> {
  throw new Error('Operator secret protection is not implemented');
}
