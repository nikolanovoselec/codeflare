// REQ-OPERATOR-005: restricted container env is derived only from the durable parent profile.
import { describe, expect, it } from 'vitest';
import { buildEnvVars, type ContainerEnvState } from '../../container/container-env';
import type { Env } from '../../types';
import type { OperatorContainerProfile } from '../../container/operator-context';

const profile: OperatorContainerProfile = { schemaVersion: 1, activityId: 'activity-1', sessionId: 'session-1', ownerBucket: 'owner-bucket',
  policyDigest: 'b'.repeat(64), deadline: Date.now() + 600_000,
  outputPrefix: 'Remote Reviews/activity-1/session-1/',
  human: { subject: 'human-1', email: 'owner@example.test', issuer: 'https://issuer.example.test/', audiences: ['aud-1'] },
  policy: { schemaVersion: 1, networkHosts: [], github: { repositories: [], methods: [] },
    storage: { readPrefixes: ['input/'], writePrefixes: ['output/'] }, inference: { routeIds: ['route-1'],
      defaultRouteId: 'route-1', reasoningLevels: ['medium'], defaultReasoningLevel: 'medium', inheritUserDefaults: false } },
  jwtPolicy: { mode: 'off', destinations: [] }, piProfile: { provider: 'anthropic', model: 'approved', thinkingLevel: 'medium',
    systemPrompt: 'Approved operator context', tools: ['read', 'bash'] } };

function state(overrides: Partial<ContainerEnvState> = {}): ContainerEnvState {
  return { _bucketName: 'owner-bucket', _r2AccountId: 'account', _r2Endpoint: 'https://r2.example.test',
    _r2AccessKeyId: 'real-r2-key', _r2SecretAccessKey: 'real-r2-secret', _strictEgress: false,
    _r2SseDisabled: false, _workspaceSyncEnabled: true, _fastStartEnabled: true, _tabConfig: null,
    _openaiApiKey: 'real-openai', _geminiApiKey: 'real-gemini', _githubToken: 'real-github',
    _cloudflareApiToken: 'real-cloudflare', _cloudflareAccountId: 'cf-account', _encryptionKey: 'real-master-key',
    _sessionMode: 'default', _sessionWorkspace: 'terminal', _terminalMode: 'classic', _containerAuthToken: 'host-token',
    _sessionId: 'session-1', _userEmail: 'owner@example.test', _userGroups: [], _routeCatalog: ['route-1'],
    _defaultRoute: 'route-1', _defaultReasoning: 'medium', _routeContextWindows: {}, _routeReasoningLevels: {},
    _modelDisplayNames: {}, _promptCacheTargets: [], _userTimezone: null, _gitCloneRepo: 'octo/repo', _gitCloneRef: null,
    _remoteCurationActive: true, _remoteCurationReleaseDigest: 'a'.repeat(64), _remoteCurationManifestDigest: 'b'.repeat(64),
    _managedResourcePolicy: 'immutable', _managedResourcePathsDigest: 'c'.repeat(64), ...overrides };
}

describe('operator container environment', () => {
  it('emits parent-bound Pi config and no broad credentials or whole-home restore', () => {
    const vars = buildEnvVars(state({ _operatorContainerProfile: profile }), { ENTERPRISE_MODE: 'active' } as Env);
    expect(vars.R2_ACCESS_KEY_ID).not.toBe('real-r2-key');
    expect(vars.R2_SECRET_ACCESS_KEY).not.toBe('real-r2-secret');
    expect(vars).not.toHaveProperty('ENCRYPTION_KEY');
    expect(vars).not.toHaveProperty('CODEFLARE_OPENAI_API_KEY');
    expect(vars).not.toHaveProperty('CODEFLARE_GEMINI_API_KEY');
    expect(vars).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
    expect(vars.GH_TOKEN).not.toBe('real-github');
    expect(vars.WORKSPACE_SYNC_ENABLED).toBe('false');
    expect(vars.SYNC_MODE).toBe('none');
    expect(vars.CODEFLARE_OPERATOR_SESSION).toBe('true');
    expect(JSON.parse(vars.CODEFLARE_OPERATOR_PI_CONFIG)).toEqual({ schemaVersion: 1, activityId: 'activity-1', sessionId: 'session-1',
      root: '/home/user/.codeflare/operators/activity-1', profile: profile.piProfile });
    expect(vars.CODEFLARE_OPERATOR_PI_CONFIG).not.toContain('owner@example.test');
    expect(JSON.parse(vars.CODEFLARE_OPERATOR_SYNC_CONFIG)).toEqual({ schemaVersion: 1,
      activityId: 'activity-1', sessionId: 'session-1', policyDigest: 'b'.repeat(64),
      root: '/home/user/.codeflare/operators/activity-1/output',
      remotePrefix: 'Remote Reviews/activity-1/session-1/', deadline: profile.deadline });
    expect(vars.CODEFLARE_OPERATOR_SYNC_CONFIG).not.toContain('owner@example.test');
    expect(vars).not.toHaveProperty('GIT_CLONE_REPO');
    expect(vars).not.toHaveProperty('REMOTE_CURATION_ACTIVE');
  });

  it('preserves ordinary non-enterprise credential and full-sync behavior when no profile exists', () => {
    const vars = buildEnvVars(state({ _operatorContainerProfile: undefined }), {} as Env);
    expect(vars.R2_ACCESS_KEY_ID).toBe('real-r2-key');
    expect(vars.R2_SECRET_ACCESS_KEY).toBe('real-r2-secret');
    expect(vars.ENCRYPTION_KEY).toBe('real-master-key');
    expect(vars.CODEFLARE_OPENAI_API_KEY).toBe('real-openai');
    expect(vars.CODEFLARE_GEMINI_API_KEY).toBe('real-gemini');
    expect(vars.GH_TOKEN).toBe('real-github');
    expect(vars.CLOUDFLARE_API_TOKEN).toBe('real-cloudflare');
    expect(vars.WORKSPACE_SYNC_ENABLED).toBe('true');
    expect(vars.SYNC_MODE).toBe('full');
    expect(vars).not.toHaveProperty('CODEFLARE_OPERATOR_SESSION');
    expect(vars).not.toHaveProperty('CODEFLARE_OPERATOR_PI_CONFIG');
    expect(vars).not.toHaveProperty('CODEFLARE_OPERATOR_SYNC_CONFIG');
    expect(vars.GIT_CLONE_REPO).toBe('octo/repo');
    expect(vars.REMOTE_CURATION_ACTIVE).toBe('true');
  });
});
