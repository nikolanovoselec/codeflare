/**
 * Admin-global Cloudflare Browser Rendering credentials (REQ-BROWSER-007 / REQ-BROWSER-008).
 *
 * In enterprise mode the per-user "Push & Deploy" settings accordion is hidden, so a
 * session's Cloudflare Browser Rendering token — used by the browser-run MCP servers
 * and the Pi native browser_* extension — comes from a single admin-configured value
 * set in the Setup wizard, not from per-user deploy-keys.
 *
 * REQ-BROWSER-008 (threat-model change): the real "Browser Rendering - Edit" token must
 * NEVER enter the container. The container env path receives only the non-secret
 * placeholder (`ENTERPRISE_BROWSER_TOKEN_PLACEHOLDER`) as CLOUDFLARE_API_TOKEN so
 * browser-run runs in authed mode; the CloudflareBrowserInterceptor strips the
 * placeholder and injects the real token worker-side, ONLY for the wizard-configured
 * browser account's `/browser-rendering/*` path. The real token stays at rest in KV
 * (`SETUP_KEYS.BROWSER_RENDER_TOKEN`) and is read worker-side by the interceptor
 * ({@link getEnterpriseBrowserCreds}). Non-enterprise modes are untouched: users still
 * set their own real token via the accordion and it rides the deploy-keys path.
 */
import type { Env, DeployKeys } from '../types';
import { isEnterpriseMode } from './subscription';
import { getAndDecrypt } from './kv-crypto';
import { SETUP_KEYS } from './kv-keys';
import { ENTERPRISE_BROWSER_TOKEN_PLACEHOLDER } from './constants';

/** Shape of the encrypted admin Browser Rendering token blob at rest. */
interface StoredBrowserToken {
  token: string;
}

/**
 * Read the admin-global Browser Rendering credentials (real token + account id) from KV.
 * WORKER-SIDE ONLY — the real token is for the CloudflareBrowserInterceptor's injection,
 * never for the container env. Returns nulls in non-enterprise or when unconfigured.
 */
export async function getEnterpriseBrowserCreds(
  env: Env,
  cryptoKey: CryptoKey | null,
): Promise<{ token: string | null; accountId: string | null }> {
  if (!isEnterpriseMode(env)) return { token: null, accountId: null };
  const stored = await getAndDecrypt<StoredBrowserToken>(env.KV, SETUP_KEYS.BROWSER_RENDER_TOKEN, cryptoKey);
  const accountId = await env.KV.get(SETUP_KEYS.BROWSER_RENDER_ACCOUNT_ID);
  return { token: stored?.token ?? null, accountId: accountId ?? null };
}

/**
 * In enterprise mode, override the Cloudflare deploy-key fields so the container receives
 * the non-secret PLACEHOLDER (not the real token) as CLOUDFLARE_API_TOKEN, plus the
 * non-secret browser account id (browser-run builds its URL from it, and the interceptor
 * matches that account). The GitHub token and every other field pass through unchanged.
 * Returns the input untouched in non-enterprise modes.
 *
 * The placeholder is emitted ONLY when a real token is configured, so the
 * token-not-configured case resolves to `null` → browser-run stays unregistered
 * (REQ-BROWSER-007). The real token is injected worker-side by the
 * CloudflareBrowserInterceptor (REQ-BROWSER-008), never written here.
 */
export async function applyEnterpriseBrowserToken(
  env: Env,
  deployKeys: DeployKeys | null | undefined,
  cryptoKey: CryptoKey | null,
): Promise<DeployKeys | null | undefined> {
  if (!isEnterpriseMode(env)) return deployKeys;

  const { token, accountId } = await getEnterpriseBrowserCreds(env, cryptoKey);

  return {
    ...deployKeys,
    // Placeholder only — the real token never enters the container (REQ-BROWSER-008).
    cloudflareApiToken: token ? ENTERPRISE_BROWSER_TOKEN_PLACEHOLDER : null,
    cloudflareAccountId: accountId ?? null,
  };
}
