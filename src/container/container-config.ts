/**
 * container-config - Config/state seam for the Container DO.
 *
 * Extracted from index.ts (CF-012). Holds the state-mutating config logic
 * that the thin DO class delegates to: setBucketName, getBucketName,
 * updateEnvVars, and ensureVaultKey. Functions receive the DO instance via
 * the ContainerHost surface instead of being methods, so the class in
 * index.ts is pure composition wiring.
 */
import type { Env } from '../types';
import { toErrorMessage } from '../lib/error-types';
import { createLogger } from '../lib/logger';
import {
  buildEnvVars,
  applyBucketName,
  type ContainerEnvState,
  type SetBucketNameCreds,
} from './container-env';

/**
 * The subset of the Container DO surface that the config + router + lifecycle
 * helpers read and write. The class implements this implicitly (it has all
 * these members), so the helpers can be plain functions taking `host` instead
 * of methods bound to `this`. This mirrors the MetricsState / ContainerEnvState
 * pattern in the sibling modules.
 */
export interface ContainerHost extends ContainerEnvState {
  readonly env: Env;
  readonly ctx: DurableObjectState<Env>;
  readonly logger: ReturnType<typeof createLogger>;
  envVars: Record<string, string>;
  idleTimeoutPref: string;
  _vaultKey: string | null;
}

/**
 * Update envVars with the current bucket name and credentials.
 *
 * Generates the container auth token on first need, then persists it so a
 * subsequent DO wake restores the same value (the container's env var
 * CONTAINER_AUTH_TOKEN, set when the container started, survives hibernation;
 * the DO's in-memory copy does not, so re-generating here would produce a
 * token mismatch - see the restore in the constructor's
 * blockConcurrencyWhile).
 *
 * ctx.waitUntil pins the put to the request lifecycle so the runtime cannot
 * hibernate the DO before the storage write commits; without that pin, a
 * wake-then-immediately-hibernate sequence could regenerate a fresh token on
 * the next wake even after this branch ran.
 */
export function updateEnvVars(host: ContainerHost): void {
  if (!host._containerAuthToken) {
    host._containerAuthToken = crypto.randomUUID();
    // Promise.resolve() wrap: in production ctx.storage.put returns a
    // Promise per the Workers Runtime API, but some test mocks return
    // undefined synchronously. Wrapping makes `.catch` safe in both.
    const putPromise = Promise.resolve(
      host.ctx.storage.put('containerAuthToken', host._containerAuthToken),
    ).catch((err) => {
      host.logger.warn('Failed to persist containerAuthToken', { error: toErrorMessage(err) });
    });
    // waitUntil is unavailable on some test mocks of ctx; guard so unit
    // tests that don't stub it don't crash. Production always has it.
    if (typeof host.ctx.waitUntil === 'function') {
      host.ctx.waitUntil(putPromise);
    }
  }

  host.envVars = buildEnvVars(host, host.env);
}

/** Set the bucket name for this container (called by worker on first access). */
export async function setBucketName(
  host: ContainerHost,
  name: string,
  r2Creds?: SetBucketNameCreds,
): Promise<void> {
  await applyBucketName(host, name, host.env, host.ctx.storage, r2Creds);
  updateEnvVars(host);
}

/** Get the bucket name. */
export function getBucketName(host: ContainerHost): string | null {
  return host._bucketName;
}

/**
 * REQ-VAULT-008 AC1: Return the per-session vault encryption key,
 * generating + persisting on the first call. The key is 32 random
 * bytes, base64-encoded so SilverBullet can use it as a string token
 * in BootConfig. Repeated calls return the cached value -- no extra
 * storage writes.
 *
 * The key is wiped only on container.destroy(); a DO hibernation +
 * wake cycle restores the same key from ctx.storage (see the
 * constructor's restore branch). This is the guarantee that deletion
 * is forward-secret: once destroy() runs, the key is gone everywhere
 * and the browser's IDB ciphertext is unrecoverable.
 *
 * Worker callers reach this method via a DO RPC from the /.config
 * proxy handler (REQ-VAULT-008 AC3).
 */
export async function ensureVaultKey(host: ContainerHost): Promise<string> {
  if (host._vaultKey) return host._vaultKey;

  // Critical-section body: re-check cache, restore from storage,
  // mint on first miss, and PERSIST INLINE before returning. Must
  // run inside blockConcurrencyWhile so a concurrent second caller
  // queued behind the first sees the persisted key on its own
  // storage.get (REQ-VAULT-008 AC1). The put MUST be awaited inside
  // the critical section - using waitUntil would let the block exit
  // before the write commits, defeating the guard.
  const mintAndPersist = async (): Promise<string> => {
    if (host._vaultKey) return host._vaultKey;
    const existing = await host.ctx.storage.get<string>('vaultKey');
    if (existing) {
      host._vaultKey = existing;
      return existing;
    }
    // No cached key -- mint one. crypto.getRandomValues is the
    // WebCrypto entry point available on the Workers runtime.
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    // Convert to base64 without Buffer (not available on Workers).
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const key = btoa(binary);
    // Promise.resolve wrap matches the containerAuthToken pattern:
    // production returns a real Promise but some test mocks return
    // undefined synchronously, so awaiting the bare call would NPE
    // without the wrap.
    //
    // CRITICAL: do NOT swallow persistence errors. If storage.put
    // silently fails, we would return `key` to the caller (the
    // Worker injects it into BootConfig, browser encrypts IDB with
    // it), then on the next DO wake the storage.get(key) returns
    // null and we mint a fresh key - permanently breaking IDB
    // decryption. Better to throw and force the caller to retry.
    try {
      await Promise.resolve(host.ctx.storage.put('vaultKey', key));
    } catch (err) {
      // Clear the in-memory mint so the next call retries instead
      // of returning a key we know was never persisted.
      host._vaultKey = null;
      const wrapped = err instanceof Error ? err : new Error(toErrorMessage(err));
      host.logger.error('Failed to persist vaultKey', wrapped);
      throw new Error(`ensureVaultKey: storage.put failed: ${toErrorMessage(err)}`);
    }
    host._vaultKey = key;
    return key;
  };

  // Race guard: two concurrent first-callers must NOT both mint
  // distinct keys. blockConcurrencyWhile serialises the full
  // get + mint + put sequence so the second caller's storage.get
  // sees the first caller's persisted key. Without this the browser
  // could be handed key A while storage retains key B, permanently
  // breaking IDB decryption on the next DO wake.
  const blocker = host.ctx.blockConcurrencyWhile;
  if (typeof blocker === 'function') {
    let result = '';
    await blocker.call(host.ctx, async () => {
      result = await mintAndPersist();
    });
    return result;
  }
  // Test mocks without blockConcurrencyWhile: best-effort, no guard.
  return mintAndPersist();
}
