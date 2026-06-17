// Scope-tier label catalogs for the OAuth connect cards (REQ-AGENT-028).
// The selected tier is sent to the server as a `tier` query param; the actual
// OAuth scope strings live server-side (src/lib/oauth-scopes.ts) so the client
// only carries the tier name.

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
    description: 'Everything including Pages, AI, Browser Rendering, Containers, Queues, and more.',
  },
};
