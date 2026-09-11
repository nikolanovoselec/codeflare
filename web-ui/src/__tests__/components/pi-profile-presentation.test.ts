import { describe, expect, it } from 'vitest';
import { profileDisplayName, profileValidationBasis } from '../../components/admin/pi-profile-presentation';

describe('REQ-ENTERPRISE-045: provider-aware Pi compatibility profiles', () => {
  it('preserves a custom name without inventing a tested provider', () => {
    const profile = { id: 'custom-team', name: 'Team translation' };
    expect(profileDisplayName(profile)).toBe('Team translation');
    expect(profileValidationBasis(profile)).toBeUndefined();
  });
});
