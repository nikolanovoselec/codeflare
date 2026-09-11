/**
 * Enterprise AI Gateway configuration — wizard-first, deploy-secret fallback
 * (REQ-ENTERPRISE-006 amended, REQ-ENTERPRISE-017).
 *
 * The customer's AI Gateway URL, optional account-API gateway name, and token used by the enterprise LLM interception
 * (REQ-ENTERPRISE-004) are now configurable in the Setup wizard and persisted in KV:
 * the URL and optional name plain (`SETUP_KEYS.AIG_GATEWAY_URL` / `AIG_GATEWAY_ID`, non-secret), the token encrypted
 * (`SETUP_KEYS.AIG_TOKEN`, via kv-crypto — same shape as the Browser Rendering token,
 * see {@link import('./browser-render-token')}). The deploy-time GitHub secrets
 * (`env.AIG_GATEWAY_URL` / `env.AIG_TOKEN`) remain as an OPTIONAL fallback, so existing
 * deployments keep working unchanged and a fresh deploy can be configured entirely from
 * the wizard.
 *
 * Resolution order (per field, independently): KV (wizard) first, then env (deploy secret).
 * Resolved ONCE by the container DO at wiring time and passed to the LlmInterceptor via
 * props — the secret stays Worker-side and never enters the container, exactly as before.
 */
import type { Env } from '../types';
import { getOrImportKey, getAndDecrypt } from './kv-crypto';
import { SETUP_KEYS } from './kv-keys';

/** Shape of the encrypted AI Gateway token blob at rest (mirrors the Browser Rendering token). */
interface StoredAigToken {
  token: string;
}

/** Resolved AI Gateway config: saved KV values take precedence over deploy-secret (env) fallback. */
interface AigConfig {
  gatewayUrl: string | undefined;
  gatewayId: string | undefined;
  token: string | undefined;
}

/**
 * Resolve the AI Gateway URL + token, KV-first with env fallback only when no
 * saved credential exists. Unreadable saved credentials fail closed; substituting
 * another token would change the connection identity that routing verified.
 */
export async function getAigConfig(env: Env): Promise<AigConfig> {
  if (!env.KV) return { gatewayUrl: env.AIG_GATEWAY_URL || undefined, gatewayId: env.AIG_GATEWAY_ID || undefined, token: env.AIG_TOKEN || undefined };
  let gatewayUrl: string | undefined;
  let gatewayId: string | undefined;
  try {
    gatewayUrl = (await env.KV.get(SETUP_KEYS.AIG_GATEWAY_URL)) || env.AIG_GATEWAY_URL || undefined;
    gatewayId = (await env.KV.get(SETUP_KEYS.AIG_GATEWAY_ID)) || env.AIG_GATEWAY_ID || undefined;
    const raw = await env.KV.get(SETUP_KEYS.AIG_TOKEN);
    if (!raw) return { gatewayUrl, gatewayId, token: env.AIG_TOKEN || undefined };
    const cryptoKey = await getOrImportKey(env);
    if (raw.startsWith('v1:') && !cryptoKey) return { gatewayUrl, gatewayId, token: undefined };
    const stored = await getAndDecrypt<StoredAigToken>(env.KV, SETUP_KEYS.AIG_TOKEN, cryptoKey);
    const token = typeof stored?.token === 'string' && stored.token.length > 0 && !/[\u0000-\u001f\u007f]/.test(stored.token) ? stored.token : undefined;
    return { gatewayUrl, gatewayId, token };
  } catch {
    return { gatewayUrl, gatewayId, token: undefined };
  }
}
