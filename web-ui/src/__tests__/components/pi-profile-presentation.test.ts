import { describe, expect, it } from 'vitest';
import { profileDisplayName, profileValidationBasis } from '../../components/admin/pi-profile-presentation';

describe('REQ-ENTERPRISE-045/064: provider-aware Pi compatibility profiles', () => {
  it('preserves a custom name without inventing a tested provider', () => {
    const profile = { id: 'custom-team', name: 'Team translation' };
    expect(profileDisplayName(profile)).toBe('Team translation');
    expect(profileValidationBasis(profile)).toBeUndefined();
  });

  it('presents the three Bedrock choices by route category and model family without transport jargon', () => {
    expect(profileDisplayName({ id: 'dynamic-bedrock-anthropic-provider-default' })).toBe('Dynamic Route - AWS Bedrock - Claude');
    expect(profileDisplayName({ id: 'bedrock-anthropic-native-sonnet' })).toBe('Native Route - AWS Bedrock - Claude Sonnet');
    expect(profileDisplayName({ id: 'bedrock-anthropic-native-opus-stream' })).toBe('Native Route - AWS Bedrock - Claude Opus');
    expect(profileDisplayName({ id: 'bedrock-anthropic-native-opus-invoke' })).toBe('Native Route - AWS Bedrock - Claude Opus');
  });
});
