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

/** Cloudflare API tokens page — users select the "Edit Cloudflare Workers" template. */
export const CLOUDFLARE_TOKEN_PAGE = 'https://dash.cloudflare.com/profile/api-tokens';

/** Documentation page listing all scopes per tier with explanations. */
export const SCOPES_DOCS_URL = 'https://github.com/nikolanovoselec/codeflare/blob/main/documentation/token-scopes.md';

/** Cloudflare brand color for instruction highlights. */
export const CLOUDFLARE_BRAND_COLOR = '#f38020';
