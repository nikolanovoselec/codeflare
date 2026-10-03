import type { Env } from '../types';

/** Native provider destinations from the lock-integrity-verified Pi 0.99.1 catalog and auth transports. */
const PERSONAL_PI_HOSTS: readonly string[] = [
  "ai-gateway.vercel.sh",
  "aiplatform.googleapis.com",
  "api.ant-ling.com",
  "api.anthropic.com",
  "api.business.githubcopilot.com",
  "api.cerebras.ai",
  "api.cloudflare.com",
  "api.deepseek.com",
  "api.enterprise.githubcopilot.com",
  "api.fireworks.ai",
  "api.githubcopilot.com",
  "api.groq.com",
  "api.individual.githubcopilot.com",
  "api.kimi.com",
  "api.meta.ai",
  "api.minimax.io",
  "api.minimaxi.com",
  "api.mistral.ai",
  "api.moonshot.ai",
  "api.moonshot.cn",
  "api.openai.com",
  "api.together.ai",
  "api.typesafe.ai",
  "api.x.ai",
  "api.xiaomimimo.com",
  "api.z.ai",
  "auth.kimi.com",
  "auth.meta.com",
  "auth.openai.com",
  "auth.x.ai",
  "chatgpt.com",
  "claude.ai",
  "gateway.ai.cloudflare.com",
  "generativelanguage.googleapis.com",
  "inference.baseten.co",
  "integrate.api.nvidia.com",
  "open.bigmodel.cn",
  "opencode.ai",
  "openrouter.ai",
  "platform.claude.com",
  "radius.pi.dev",
  "router.huggingface.co",
  "token-plan-ams.xiaomimimo.com",
  "token-plan-cn.xiaomimimo.com",
  "token-plan-sgp.xiaomimimo.com",
  "token-plan.ap-southeast-1.maas.aliyuncs.com",
  "token-plan.cn-beijing.maas.aliyuncs.com"
];
// Dynamic built-in cloud endpoints: resource/region are provider configuration,
// not a permission to send credentials to an arbitrary origin.
export const PERSONAL_PI_HOST_PATTERNS: readonly string[] = [...PERSONAL_PI_HOSTS,
  '*.openai.azure.com', '*.ai.azure.com', '*.cognitiveservices.azure.com',
  '*.aiplatform.googleapis.com', '*-aiplatform.googleapis.com', '*.amazonaws.com', '*.amazonaws.com.cn', '*.githubcopilot.com'];

/** Only the already trusted deployment GitHub domain supplies enterprise endpoints. */
export function personalPiConfiguredGithubHosts(env?: Pick<Env, 'GITHUB_HOST'>): string[] {
  const domain = env?.GITHUB_HOST?.trim().toLowerCase();
  if (!domain || domain === 'github.com') return [];
  try {
    const url = new URL(`https://${domain}`);
    if (url.hostname !== domain || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return [];
    return [domain, `api.${domain}`, `copilot-api.${domain}`];
  } catch { return []; }
}

export function isPersonalPiDestination(url: URL, env?: Pick<Env, 'GITHUB_HOST'>): boolean {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname;
  const configured = personalPiConfiguredGithubHosts(env);
  if (host === configured[0]) return ['/login/device/code', '/login/oauth/access_token'].includes(url.pathname);
  if (host === configured[1]) return url.pathname === '/copilot_internal/v2/token';
  if (host === configured[2]) return true;
  if (host === 'api.cloudflare.com') return /^\/client\/v4\/accounts\/[^/]+\/ai(?:\/|$)/.test(url.pathname);
  if (host === 'github.com') return ['/login/device/code', '/login/oauth/access_token'].includes(url.pathname);
  if (host === 'api.github.com') return url.pathname === '/copilot_internal/v2/token';
  if (host === 'api.githubcopilot.com') return url.pathname !== '/mcp' && !url.pathname.startsWith('/mcp/');
  return PERSONAL_PI_HOSTS.includes(host)
    || /^api\.(?:[a-z0-9-]+\.)+githubcopilot\.com$/.test(host)
    || /^(?:[a-z0-9-]+\.)+(?:openai\.azure\.com|ai\.azure\.com|cognitiveservices\.azure\.com)$/.test(host)
    || /^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/.test(host)
    || /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(host);
}

/** Hosts claimed by provider-family wildcards but not necessarily inference. */
export function isPersonalPiCloudFamily(url: URL): boolean {
  return url.protocol === 'https:' && !url.username && !url.password && !url.port
    && /(?:\.amazonaws\.com(?:\.cn)?|\.openai\.azure\.com|\.ai\.azure\.com|\.cognitiveservices\.azure\.com|[.-]aiplatform\.googleapis\.com)$/.test(url.hostname);
}
