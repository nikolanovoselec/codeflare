// Implements REQ-AGENT-010, REQ-AGENT-028
import { describe, it, expect } from 'vitest';
import {
  getGithubTokenUrl,
  GITHUB_TIERS,
  getCloudflareTokenUrl,
  CLOUDFLARE_TIERS,
} from '../../lib/token-scopes';

describe('GITHUB_TIERS / REQ-AGENT-010 (deploy credential token scope tiers)', () => {
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

describe('CLOUDFLARE_TIERS / REQ-AGENT-028 AC2 (Cloudflare token scope tiers)', () => {
  it('has exactly 3 tiers', () => {
    expect(Object.keys(CLOUDFLARE_TIERS)).toHaveLength(3);
  });

  it('has minimal, recommended, and advanced', () => {
    expect(CLOUDFLARE_TIERS.minimal).toBeDefined();
    expect(CLOUDFLARE_TIERS.recommended).toBeDefined();
    expect(CLOUDFLARE_TIERS.advanced).toBeDefined();
  });

  it('each tier has label and description', () => {
    for (const tier of Object.values(CLOUDFLARE_TIERS)) {
      expect(tier.label).toBeTruthy();
      expect(tier.description).toBeTruthy();
    }
  });
});

describe('getCloudflareTokenUrl', () => {
  it('all tiers include permissionGroupKeys and name=Codeflare', () => {
    for (const tier of ['minimal', 'recommended', 'advanced'] as const) {
      const url = getCloudflareTokenUrl(tier);
      expect(url).toContain('permissionGroupKeys=');
      expect(url).toContain('name=Codeflare');
      expect(url).toContain('accountId=%2A');
      expect(url).toContain('zoneId=all');
    }
  });

  it('minimal has 7 scopes', () => {
    const url = getCloudflareTokenUrl('minimal');
    const params = new URL(url).searchParams;
    const scopes = JSON.parse(params.get('permissionGroupKeys')!);
    expect(scopes).toHaveLength(7);
  });

  it('recommended has 10 scopes (superset of minimal)', () => {
    const url = getCloudflareTokenUrl('recommended');
    const params = new URL(url).searchParams;
    const scopes = JSON.parse(params.get('permissionGroupKeys')!);
    expect(scopes).toHaveLength(10);

    const minimalUrl = getCloudflareTokenUrl('minimal');
    const minimalScopes = JSON.parse(new URL(minimalUrl).searchParams.get('permissionGroupKeys')!);
    for (const scope of minimalScopes) {
      expect(scopes).toContainEqual(scope);
    }
  });

  it('advanced has 23 scopes (superset of recommended)', () => {
    const url = getCloudflareTokenUrl('advanced');
    const params = new URL(url).searchParams;
    const scopes = JSON.parse(params.get('permissionGroupKeys')!);
    expect(scopes).toHaveLength(23);

    const recUrl = getCloudflareTokenUrl('recommended');
    const recScopes = JSON.parse(new URL(recUrl).searchParams.get('permissionGroupKeys')!);
    for (const scope of recScopes) {
      expect(scopes).toContainEqual(scope);
    }
  });

  it('minimal includes core Worker scopes', () => {
    const url = getCloudflareTokenUrl('minimal');
    const scopes = JSON.parse(new URL(url).searchParams.get('permissionGroupKeys')!);
    const keys = scopes.map((s: { key: string }) => s.key);
    expect(keys).toContain('workers_scripts');
    expect(keys).toContain('workers_kv_storage');
    expect(keys).toContain('workers_r2');
    expect(keys).toContain('d1');
  });

  it('minimal does NOT include dns or access', () => {
    const url = getCloudflareTokenUrl('minimal');
    const scopes = JSON.parse(new URL(url).searchParams.get('permissionGroupKeys')!);
    const keys = scopes.map((s: { key: string }) => s.key);
    expect(keys).not.toContain('dns');
    expect(keys).not.toContain('access');
  });

  it('recommended includes dns and access', () => {
    const url = getCloudflareTokenUrl('recommended');
    const scopes = JSON.parse(new URL(url).searchParams.get('permissionGroupKeys')!);
    const keys = scopes.map((s: { key: string }) => s.key);
    expect(keys).toContain('dns');
    expect(keys).toContain('access');
    expect(keys).toContain('access_acct');
  });

  it('advanced includes AI, Containers, Queues, and Agents', () => {
    const url = getCloudflareTokenUrl('advanced');
    const scopes = JSON.parse(new URL(url).searchParams.get('permissionGroupKeys')!);
    const keys = scopes.map((s: { key: string }) => s.key);
    expect(keys).toContain('ai');
    expect(keys).toContain('containers');
    expect(keys).toContain('queues');
    expect(keys).toContain('cf_agents');
    expect(keys).toContain('challenge_widgets');
    expect(keys).toContain('workers_ci');
    expect(keys).toContain('r2_catalog');
  });

  // REQ-BROWSER-002: Browser Rendering edit scope enables Cloudflare Browser Run.
  it('advanced includes browser_rendering edit (Browser Rendering)', () => {
    const url = getCloudflareTokenUrl('advanced');
    const scopes = JSON.parse(new URL(url).searchParams.get('permissionGroupKeys')!);
    expect(scopes).toContainEqual({ key: 'browser_rendering', type: 'edit' });
  });

  it('recommended does NOT include browser_rendering', () => {
    const url = getCloudflareTokenUrl('recommended');
    const scopes = JSON.parse(new URL(url).searchParams.get('permissionGroupKeys')!);
    const keys = scopes.map((s: { key: string }) => s.key);
    expect(keys).not.toContain('browser_rendering');
  });
});
