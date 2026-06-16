/**
 * Admin-global Cloudflare Browser Rendering credentials (REQ-BROWSER-007).
 *
 * In enterprise mode the per-user "Push & Deploy" settings accordion is hidden, so a
 * session's Cloudflare Browser Rendering token — used by the browser-run MCP servers
 * and the Pi native browser_* extension — comes from a single admin-configured value
 * set in the Setup wizard, not from per-user deploy-keys.
 *
 * The token is the narrowly-scoped "Browser Rendering - Edit" credential. Per the
 * enterprise threat model it is allowed to enter the container env (it grants only
 * Browser Rendering, nothing the agent cannot already do through its own browser
 * tools), so it rides the existing deploy-keys -> CLOUDFLARE_API_TOKEN env path
 * rather than egress injection. Non-enterprise modes are untouched: users still set
 * their own token via the accordion.
 */
import type { Env, DeployKeys } from '../types';
import { isEnterpriseMode } from './subscription';
import { getAndDecrypt } from './kv-crypto';
import { SETUP_KEYS } from './kv-keys';

/** Shape of the encrypted admin Browser Rendering token blob at rest. */
interface StoredBrowserToken {
  token: string;
}

/**
 * In enterprise mode, override the Cloudflare deploy-key fields with the admin-global
 * Browser Rendering token + account id from Setup. The GitHub token and every other
 * field pass through unchanged. Returns the input untouched in non-enterprise modes.
 * In enterprise mode the return is always a fresh object (never null/undefined); the
 * nullable return type reflects only the non-enterprise passthrough of the input.
 *
 * When nothing is configured the Cloudflare fields resolve to `null`, which the
 * container env path treats as "no Cloudflare token" — browser-run then stays
 * unregistered (the desired token-not-configured behaviour, REQ-BROWSER-007).
 */
export async function applyEnterpriseBrowserToken(
  env: Env,
  deployKeys: DeployKeys | null | undefined,
  cryptoKey: CryptoKey | null,
): Promise<DeployKeys | null | undefined> {
  if (!isEnterpriseMode(env)) return deployKeys;

  const stored = await getAndDecrypt<StoredBrowserToken>(env.KV, SETUP_KEYS.BROWSER_RENDER_TOKEN, cryptoKey);
  const accountId = await env.KV.get(SETUP_KEYS.BROWSER_RENDER_ACCOUNT_ID);

  return {
    ...deployKeys,
    cloudflareApiToken: stored?.token ?? null,
    cloudflareAccountId: accountId ?? null,
  };
}
