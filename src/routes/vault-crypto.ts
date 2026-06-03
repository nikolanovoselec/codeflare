/**
 * Vault encryption-key accessor (CF-024a extraction from vault.ts).
 *
 * The container Durable Object exposes `ensureVaultKey()` (REQ-VAULT-008
 * AC1), but the `@cloudflare/containers` getContainer() return type does
 * not surface our DO's custom methods. Declaring the contract once here
 * lets `getVaultEncryptionKey` perform a single, named cast and hand the
 * rest of the module a typed accessor.
 */

/**
 * Typed view of the container Durable Object stub for the one RPC the
 * vault proxy needs: `ensureVaultKey()` (REQ-VAULT-008 AC1). The
 * `@cloudflare/containers` getContainer() return type does not expose
 * our DO's custom methods, so previously three call sites reached the
 * method through `(container as unknown as { ensureVaultKey... })`
 * double-casts (CF-002). Declaring the contract once here lets
 * `getVaultEncryptionKey` perform a single, named cast and hand the
 * rest of the module a typed accessor.
 */
interface VaultKeyProvider {
  ensureVaultKey(): Promise<string>;
}

export function getVaultEncryptionKey(container: unknown): Promise<string> {
  return (container as VaultKeyProvider).ensureVaultKey();
}
