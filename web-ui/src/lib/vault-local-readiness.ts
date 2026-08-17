export interface VaultKeyRecoverableOptions {
  fetchRef?: typeof fetch | null;
}

/**
 * Network proof that the Vault encryption key can be served for `sessionId`
 * before the current prewarm attempt arms the button. This uses the same
 * auth-gated endpoint as the native worker's cold-restart recovery and fails
 * closed on any unavailable, malformed, or empty response.
 */
export async function checkVaultKeyRecoverable(
  sessionId: string,
  options: VaultKeyRecoverableOptions = {},
): Promise<boolean> {
  const fetchRef = options.fetchRef === undefined ? (globalThis.fetch ?? null) : options.fetchRef;
  if (!fetchRef) return false;
  try {
    const res = await fetchRef(`/api/vault/${encodeURIComponent(sessionId)}/.vault-key`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'include',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { key?: unknown };
    return typeof data.key === 'string' && data.key.length > 0;
  } catch {
    return false;
  }
}
