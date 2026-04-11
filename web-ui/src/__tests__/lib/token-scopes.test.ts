// Implements REQ-AGENT-010
import { describe, it, expect } from 'vitest';
import {
  getGithubTokenUrl,
  GITHUB_TIERS,
  CLOUDFLARE_TOKEN_PAGE,
} from '../../lib/token-scopes';

describe('GITHUB_TIERS', () => {
  it('has exactly 3 tiers', () => {
    expect(Object.keys(GITHUB_TIERS)).toHaveLength(3);
  });

  it('has minimal, recommended, and advanced', () => {
    expect(GITHUB_TIERS.minimal).toBeDefined();
    expect(GITHUB_TIERS.recommended).toBeDefined();
    expect(GITHUB_TIERS.advanced).toBeDefined();
  });

  it('each tier has label and description', () => {
    for (const tier of Object.values(GITHUB_TIERS)) {
      expect(tier.label).toBeTruthy();
      expect(tier.description).toBeTruthy();
    }
  });
});

describe('getGithubTokenUrl', () => {
  it('all tiers include name=Codeflare', () => {
    expect(getGithubTokenUrl('minimal')).toContain('name=Codeflare');
    expect(getGithubTokenUrl('recommended')).toContain('name=Codeflare');
    expect(getGithubTokenUrl('advanced')).toContain('name=Codeflare');
  });

  it('all tiers include contents=write', () => {
    expect(getGithubTokenUrl('minimal')).toContain('contents=write');
    expect(getGithubTokenUrl('recommended')).toContain('contents=write');
    expect(getGithubTokenUrl('advanced')).toContain('contents=write');
  });

  // Minimal: only contents
  it('minimal does NOT include pull_requests', () => {
    expect(getGithubTokenUrl('minimal')).not.toContain('pull_requests');
  });

  it('minimal does NOT include administration', () => {
    expect(getGithubTokenUrl('minimal')).not.toContain('administration');
  });

  // Recommended: contents + PRs + actions + workflows + administration + secrets
  it('recommended includes pull_requests=write', () => {
    expect(getGithubTokenUrl('recommended')).toContain('pull_requests=write');
  });

  it('recommended includes actions=read', () => {
    expect(getGithubTokenUrl('recommended')).toContain('actions=read');
  });

  it('recommended includes workflows=write', () => {
    expect(getGithubTokenUrl('recommended')).toContain('workflows=write');
  });

  it('recommended includes administration=write', () => {
    expect(getGithubTokenUrl('recommended')).toContain('administration=write');
  });

  it('recommended includes secrets=write', () => {
    expect(getGithubTokenUrl('recommended')).toContain('secrets=write');
  });

  it('recommended does NOT include issues', () => {
    expect(getGithubTokenUrl('recommended')).not.toContain('issues');
  });

  it('recommended does NOT include copilot', () => {
    expect(getGithubTokenUrl('recommended')).not.toContain('copilot');
  });

  // Advanced: all 19 scopes
  it('advanced includes issues=write', () => {
    expect(getGithubTokenUrl('advanced')).toContain('issues=write');
  });

  it('advanced includes pages=write', () => {
    expect(getGithubTokenUrl('advanced')).toContain('pages=write');
  });

  it('advanced includes security_events=write', () => {
    expect(getGithubTokenUrl('advanced')).toContain('security_events=write');
  });

  it('advanced includes emails=read', () => {
    expect(getGithubTokenUrl('advanced')).toContain('emails=read');
  });

  it('advanced includes user_copilot_requests=read', () => {
    expect(getGithubTokenUrl('advanced')).toContain('user_copilot_requests=read');
  });
});

describe('CLOUDFLARE_TOKEN_PAGE', () => {
  it('points to Cloudflare API tokens page', () => {
    expect(CLOUDFLARE_TOKEN_PAGE).toBe('https://dash.cloudflare.com/profile/api-tokens');
  });
});
