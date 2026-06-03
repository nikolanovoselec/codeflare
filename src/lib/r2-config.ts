import { CF_API_BASE } from './constants';
import { parseCfResponse } from './cf-api';
import { ValidationError } from './error-types';
import { SETUP_KEYS } from './kv-keys';
import type { Env } from '../types';

/**
 * Resolve R2 configuration from env vars first, falling back to KV,
 * then auto-resolving from Cloudflare API token as a last resort.
 *
 * Resolution order:
 * 1. env.R2_ACCOUNT_ID (wrangler.toml [vars] or .dev.vars)
 * 2. KV key "setup:account_id" (set by setup wizard)
 * 3. Cloudflare API via env.CLOUDFLARE_API_TOKEN (self-healing: writes to KV for next time)
 */
export async function getR2Config(
  env: Pick<Env, 'R2_ACCOUNT_ID' | 'R2_ENDPOINT' | 'KV' | 'CLOUDFLARE_API_TOKEN'>
): Promise<{ accountId: string; endpoint: string }> {
  // 1. Prefer env vars (set in wrangler.toml or .dev.vars)
  const envAccountId = env.R2_ACCOUNT_ID;
  if (envAccountId) {
    const endpoint = env.R2_ENDPOINT || `https://${envAccountId}.r2.cloudflarestorage.com`;
    return { accountId: envAccountId, endpoint };
  }

  // 2. Fall back to KV (set by setup wizard)
  const kvAccountId = await env.KV.get(SETUP_KEYS.ACCOUNT_ID);
  if (kvAccountId) {
    return {
      accountId: kvAccountId,
      endpoint: `https://${kvAccountId}.r2.cloudflarestorage.com`,
    };
  }

  // 3. Self-heal: resolve from API token and cache in KV
  const token = env.CLOUDFLARE_API_TOKEN;
  if (token) {
    const res = await fetch(`${CF_API_BASE}/accounts`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await parseCfResponse<Array<{ id: string }>>(res);

    if (data.success && data.result?.length) {
      const accountId = data.result[0].id;
      const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

      // Cache in KV so this API call only happens once
      await Promise.allSettled([
        env.KV.put(SETUP_KEYS.ACCOUNT_ID, accountId),
        env.KV.put(SETUP_KEYS.R2_ENDPOINT, endpoint),
      ]);

      return { accountId, endpoint };
    }
  }

  throw new ValidationError(
    'R2 account ID not configured. Please run the setup wizard or set R2_ACCOUNT_ID.'
  );
}
