// Implements REQ-AGENT-010

export type ScopeTier = 'minimal' | 'recommended' | 'advanced';

export interface TierConfig {
  label: string;
  description: string;
}

export const GITHUB_TIERS: Record<ScopeTier, TierConfig> = {
  minimal: {
    label: 'Minimal',
    description: 'Push and pull code to existing repositories.',
  },
  recommended: {
    label: 'Recommended',
    description: 'Create repos, open PRs, monitor CI, and deploy.',
  },
  advanced: {
    label: 'Advanced',
    description: 'Everything above plus issues, Pages, webhooks, and GitHub Copilot.',
  },
};

const GITHUB_BASE_URL =
  'https://github.com/settings/personal-access-tokens/new?name=Codeflare&description=Push+%26+deploy+from+Codeflare&expires_in=90';

const GITHUB_SCOPES: Record<ScopeTier, string> = {
  minimal:
    '&contents=write&metadata=read',
  recommended:
    '&contents=write&pull_requests=write&actions=read&workflows=write'
    + '&administration=write&secrets=write&metadata=read',
  advanced:
    '&contents=write&administration=write&workflows=write&actions=write&actions_variables=write'
    + '&pull_requests=write&issues=write&deployments=write&environments=write&pages=write'
    + '&secrets=write&statuses=write&repository_hooks=write&merge_queues=write'
    + '&security_events=write&custom_properties=write&discussions=write'
    + '&metadata=read'
    + '&emails=read&user_copilot_requests=read',
};

export function getGithubTokenUrl(tier: ScopeTier): string {
  return GITHUB_BASE_URL + GITHUB_SCOPES[tier];
}

// ---------------------------------------------------------------------------
// Cloudflare token scopes (verified key mapping 2026-05-26)
// ---------------------------------------------------------------------------

export const CLOUDFLARE_TIERS: Record<ScopeTier, TierConfig> = {
  minimal: {
    label: 'Minimal',
    description: 'Deploy Workers, KV, R2, D1, and manage routes.',
  },
  recommended: {
    label: 'Recommended',
    description: 'Minimal plus DNS records and Cloudflare Access.',
  },
  advanced: {
    label: 'Advanced',
    description: 'Everything including Pages, AI, Containers, Queues, and more.',
  },
};

type CfScope = { key: string; type: string };

const CF_MINIMAL: CfScope[] = [
  { key: 'workers_scripts', type: 'edit' },
  { key: 'workers_kv_storage', type: 'edit' },
  { key: 'workers_r2', type: 'edit' },
  { key: 'd1', type: 'edit' },
  { key: 'workers_routes', type: 'edit' },
  { key: 'account_settings', type: 'read' },
  { key: 'zone', type: 'read' },
];

const CF_RECOMMENDED: CfScope[] = [
  ...CF_MINIMAL,
  { key: 'dns', type: 'edit' },
  { key: 'access', type: 'edit' },
  { key: 'access_acct', type: 'edit' },
];

const CF_ADVANCED: CfScope[] = [
  ...CF_RECOMMENDED,
  { key: 'page', type: 'edit' },
  { key: 'containers', type: 'edit' },
  { key: 'account_api_tokens', type: 'edit' },
  { key: 'queues', type: 'edit' },
  { key: 'ai', type: 'edit' },
  { key: 'ai', type: 'read' },
  { key: 'vectorize', type: 'edit' },
  { key: 'challenge_widgets', type: 'edit' },
  { key: 'workers_ci', type: 'edit' },
  { key: 'workers_observability', type: 'edit' },
  { key: 'r2_catalog', type: 'edit' },
  { key: 'cf_agents', type: 'edit' },
];

const CLOUDFLARE_SCOPES: Record<ScopeTier, CfScope[]> = {
  minimal: CF_MINIMAL,
  recommended: CF_RECOMMENDED,
  advanced: CF_ADVANCED,
};

const CLOUDFLARE_BASE_URL = 'https://dash.cloudflare.com/profile/api-tokens';

export function getCloudflareTokenUrl(tier: ScopeTier): string {
  const encoded = encodeURIComponent(JSON.stringify(CLOUDFLARE_SCOPES[tier]));
  return `${CLOUDFLARE_BASE_URL}?permissionGroupKeys=${encoded}&accountId=%2A&zoneId=all&name=Codeflare`;
}

/** Documentation page listing all scopes per tier with explanations. */
export const SCOPES_DOCS_URL = 'https://github.com/nikolanovoselec/codeflare/blob/main/documentation/lanes/configuration.md';
