import { decryptFromKV, encryptForKV, getOrImportKey } from '../lib/kv-crypto';
import { ValidationError } from '../lib/error-types';

/** Parent-generated context; separates operators/activities and secret purposes. */
export interface OperatorSecretContext {
  purpose: 'connection' | 'human-access' | 'webhook';
  recordId: string;
}

/** Generate a per-operator handoff key; caller stores ciphertext and displays plaintext once. */
export async function createOperatorWebhookKey(
  _recordId: string,
  _env: { ENCRYPTION_KEY?: string },
): Promise<{ key: string; ciphertext: string }> {
  throw new Error('Operator webhook key generation is not implemented');
}

function authenticatedContext(context: OperatorSecretContext): string {
  return JSON.stringify(['operator-secret-v1', context.purpose, context.recordId]);
}

/**
 * REQ-OPERATOR-002: Seal a parent-owned secret using the existing AES-GCM envelope.
 * Purpose and record identity are authenticated, not secret. Missing/invalid key
 * material fails closed; no plaintext fallback, persistence or logging occurs.
 * The authorized caller owns record selection and storing the returned ciphertext.
 */
export async function sealOperatorSecret(
  plaintext: string,
  env: { ENCRYPTION_KEY?: string },
  context: OperatorSecretContext,
): Promise<string> {
  try {
    const key = await getOrImportKey(env);
    if (!key) throw new Error('Encryption unavailable');
    return await encryptForKV(plaintext, key, authenticatedContext(context));
  } catch {
    throw new ValidationError('Operator secret protection failed');
  }
}

/**
 * Open only an encrypted value for its exact parent-selected purpose/record.
 * Never migrate plaintext, retry with another context/key, or disclose cryptographic
 * diagnostics. The returned secret stays parent-owned and must not enter child
 * bindings or public projections. Ordinary credential migration remains unchanged.
 */
export async function openOperatorSecret(
  ciphertext: string,
  env: { ENCRYPTION_KEY?: string },
  context: OperatorSecretContext,
): Promise<string> {
  try {
    if (!ciphertext.startsWith('v1:')) throw new Error('Encrypted value required');
    const key = await getOrImportKey(env);
    if (!key) throw new Error('Encryption unavailable');
    return await decryptFromKV(ciphertext.slice(3), key, authenticatedContext(context));
  } catch {
    throw new ValidationError('Operator secret protection failed');
  }
}
