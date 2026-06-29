/**
 * Enterprise AI Gateway configuration — wizard-first, deploy-secret fallback
 * (REQ-ENTERPRISE-006 amended, REQ-ENTERPRISE-017).
 *
 * The customer's AI Gateway URL + token used by the enterprise LLM interception
 * (REQ-ENTERPRISE-004) are now configurable in the Setup wizard and persisted in KV:
 * the URL plain (`SETUP_KEYS.AIG_GATEWAY_URL`, non-secret), the token encrypted
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

/** Resolved AI Gateway config: wizard (KV) values take precedence over deploy-secret (env) fallback. */
export interface AigConfig {
  gatewayUrl: string | undefined;
  token: string | undefined;
}

/**
 * Resolve the AI Gateway URL + token, KV-first with env fallback. A KV/crypto error at
 * the container-start seam must never fault wiring — it degrades to the env fallback. An
 * empty/absent value resolves to `undefined` so the caller can skip wiring or warn.
 */
export async function getAigConfig(env: Env): Promise<AigConfig> {
  let kvUrl: string | undefined;
  let kvToken: string | undefined;
  try {
    kvUrl = (await env.KV?.get(SETUP_KEYS.AIG_GATEWAY_URL)) ?? undefined;
    const cryptoKey = await getOrImportKey(env);
    const stored = await getAndDecrypt<StoredAigToken>(env.KV, SETUP_KEYS.AIG_TOKEN, cryptoKey);
    kvToken = stored?.token ?? undefined;
  } catch {
    // Transient KV / crypto failure: fall back to the deploy-secret env values below.
  }
  return {
    gatewayUrl: kvUrl || env.AIG_GATEWAY_URL || undefined,
    token: kvToken || env.AIG_TOKEN || undefined,
  };
}
