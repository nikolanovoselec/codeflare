import type { Env } from '../types';
import { isEnterpriseMode } from './subscription';
import { SETUP_KEYS } from './kv-keys';

/**
 * View-only storage (enterprise anti-exfil): true only when the deployment is in Enterprise
 * mode AND the admin has enabled the toggle (KV `setup:downloads_disabled` === 'active').
 * Gate-then-read mirrors {@link hasStrictGatewayEgress}: a non-enterprise deploy never
 * touches KV, and a transient KV error defaults OFF (downloads allowed) so storage stays
 * usable rather than hard-failing. Default OFF when the key is absent.
 */
export async function isDownloadsDisabled(env: Env): Promise<boolean> {
  if (!isEnterpriseMode(env)) return false;
  try {
    return (await env.KV?.get(SETUP_KEYS.DOWNLOADS_DISABLED)) === 'active';
  } catch {
    return false;
  }
}
