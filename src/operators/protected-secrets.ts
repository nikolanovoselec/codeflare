/**
 * Operator-only secret boundary
 * Key generation, authenticated-context construction, encryption and decryption are grouped below.
 * The existing AES-GCM primitive is reused without its ordinary plaintext fallback. Record/purpose
 * binding prevents secret substitution. Callers own authorization, persistence and one-time display.
 * See sdd/spec/operators.md and documentation/lanes/operators.md for acceptance boundaries.
 */
import { decryptFromKV, encryptForKV, getOrImportKey } from '../lib/kv-crypto';
import { ValidationError } from '../lib/error-types';

/** Parent-generated context; separates operators/activities and secret purposes. */
export interface OperatorSecretContext {
  purpose: 'connection' | 'human-access' | 'webhook' | 'handoff';
  recordId: string;
}

/**
 * REQ-OPERATOR-012: Generate an independent 256-bit handoff key for the authorized
 * parent's operator record. Return only after authenticated encryption succeeds.
 * The caller persists ciphertext, displays plaintext once and replaces the old
 * ciphertext on rotation; this helper does not authorize, persist or log keys.
 */
export async function createOperatorWebhookKey(
  recordId: string,
  env: { ENCRYPTION_KEY?: string },
): Promise<{ key: string; ciphertext: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const ciphertext = await sealOperatorSecret(key, env, { purpose: 'webhook', recordId });
  return { key, ciphertext };
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
