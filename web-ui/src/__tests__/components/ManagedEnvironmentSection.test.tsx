import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ManagedEnvironmentSection from '../../components/setup/ManagedEnvironmentSection';

afterEach(cleanup);

describe('Managed environment Setup section', () => {
  it('routes repository, PAT, and public-key replacements without exposing saved values', async () => {
    const onEnabledChange = vi.fn();
    const onRepositoryChange = vi.fn();
    const onPersonalAccessTokenChange = vi.fn();
    const onPublicKeyChange = vi.fn();
    const view = render(() => (
      <ManagedEnvironmentSection
        enabled
        enterpriseMode
        immutableResources={false}
        disableUserCreatedResources={false}
        repository="acme/curation"
        personalAccessToken=""
        personalAccessTokenSet
        publicKey=""
        publicKeyFingerprint="0123456789abcdef"
        activeReleaseTag="release-7"
        activeSequence={7}
        activeDigestPrefix="123456789abc"
        freshness="fresh"
        lastCheckedAt="2026-08-18T00:00:00.000Z"
        patExpiryState="valid"
        lastError="Last refresh used the verified cache"

        onEnabledChange={onEnabledChange}
        onImmutableResourcesChange={() => undefined}
        onDisableUserCreatedResourcesChange={() => undefined}
        onRepositoryChange={onRepositoryChange}
        onPersonalAccessTokenChange={onPersonalAccessTokenChange}
        onPublicKeyChange={onPublicKeyChange}
      />
    ));

    const section = view.getByTestId('managed-environment-section');
    const inputs = section.querySelectorAll('input');
    expect(inputs).toHaveLength(5);
    expect(inputs[3].type).toBe('password');
    expect(inputs[3].value).toBe('');
    expect(inputs[3].placeholder).toMatch(/saved/i);
    expect(inputs[4].disabled).toBe(false);
    expect(inputs[4].placeholder).toMatch(/replace/i);
    expect(section).not.toHaveTextContent('github_pat');
    expect(section).toHaveTextContent('Active release-7 · sequence 7 · digest 123456789abc');
    expect(section).toHaveTextContent('checked 2026-08-18T00:00:00.000Z');
    expect(section).toHaveTextContent('Last refresh used the verified cache');

    await fireEvent.input(inputs[2], { target: { value: 'other/repository' } });
    await fireEvent.input(inputs[3], { target: { value: 'replacement-pat' } });
    await fireEvent.input(inputs[4], { target: { value: 'ab'.repeat(32) } });
    expect(onRepositoryChange).toHaveBeenCalledWith('other/repository');
    expect(onPersonalAccessTokenChange).toHaveBeenCalledWith('replacement-pat');
    expect(onPublicKeyChange).toHaveBeenCalledWith('ab'.repeat(32));
  });

  it('keeps trust inputs absent while disabled and emits the disable transition', async () => {
    const onEnabledChange = vi.fn();
    const view = render(() => (
      <ManagedEnvironmentSection
        enabled={false}
        enterpriseMode
        immutableResources={false}
        disableUserCreatedResources={false}
        repository=""
        personalAccessToken=""
        personalAccessTokenSet={false}
        publicKey=""
        publicKeyFingerprint=""
        freshness="unconfigured"
        patExpiryState="unknown"
        onEnabledChange={onEnabledChange}
        onImmutableResourcesChange={() => undefined}
        onDisableUserCreatedResourcesChange={() => undefined}
        onRepositoryChange={() => undefined}
        onPersonalAccessTokenChange={() => undefined}
        onPublicKeyChange={() => undefined}
      />
    ));

    const section = view.getByTestId('managed-environment-section');
    const checkbox = section.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(section.querySelectorAll('input')).toHaveLength(1);
    await fireEvent.change(checkbox, { target: { checked: true } });
    expect(onEnabledChange).toHaveBeenCalledWith(true);
  });

  it('REQ-SETUP-015 AC1: renders nested immutable resource controls', async () => {
    const onImmutableResourcesChange = vi.fn();
    const onDisableUserCreatedResourcesChange = vi.fn();
    const view = render(() => (
      <ManagedEnvironmentSection
        enabled
        enterpriseMode
        immutableResources
        disableUserCreatedResources={false}
        repository="acme/curation"
        personalAccessToken=""
        personalAccessTokenSet
        publicKey=""
        publicKeyFingerprint="0123456789abcdef"
        freshness="fresh"
        patExpiryState="valid"
        onEnabledChange={() => undefined}
        onImmutableResourcesChange={onImmutableResourcesChange}
        onDisableUserCreatedResourcesChange={onDisableUserCreatedResourcesChange}
        onRepositoryChange={() => undefined}
        onPersonalAccessTokenChange={() => undefined}
        onPublicKeyChange={() => undefined}
      />
    ));

    const section = view.getByTestId('managed-environment-section');
    expect(section).toHaveTextContent('Immutable Resources');
    expect(section).toHaveTextContent('Disable User Created Resources');
    expect(section).toHaveTextContent('User-created resources are allowed, saved, and restored in future sessions.');
    const checkboxes = section.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(3);
    await fireEvent.change(checkboxes[1], { target: { checked: false } });
    await fireEvent.change(checkboxes[2], { target: { checked: true } });
    expect(onImmutableResourcesChange).toHaveBeenCalledWith(false);
    expect(onDisableUserCreatedResourcesChange).toHaveBeenCalledWith(true);
  });

  it.each([
    [false, false, 'Managed company resources are provisioned and updated. Users can modify them and create their own resources. New managed versions overwrite changes to managed resources.'],
    [true, false, 'Managed resources cannot be changed permanently. User-created resources are allowed, saved, and restored in future sessions. Changes to managed resources are lost when the session ends.'],
    [true, true, 'Only managed agent resources persist. Existing user-created agent resources are removed. New agent resources and changes to managed resources are lost when the session ends.'],
  ] as const)('REQ-SETUP-015 AC6: describes the selected managed-resource mode', (immutableResources, disableUserCreatedResources, description) => {
    const view = render(() => (
      <ManagedEnvironmentSection
        enabled
        enterpriseMode
        immutableResources={immutableResources}
        disableUserCreatedResources={disableUserCreatedResources}
        repository="acme/curation"
        personalAccessToken=""
        personalAccessTokenSet
        publicKey=""
        publicKeyFingerprint="0123456789abcdef"
        freshness="fresh"
        patExpiryState="valid"
        onEnabledChange={() => undefined}
        onImmutableResourcesChange={() => undefined}
        onDisableUserCreatedResourcesChange={() => undefined}
        onRepositoryChange={() => undefined}
        onPersonalAccessTokenChange={() => undefined}
        onPublicKeyChange={() => undefined}
      />
    ));

    expect(view.getByTestId('managed-resource-policy-description')).toHaveTextContent(description);
    expect(view.getByTestId('managed-resource-policy-transition')).toHaveTextContent('The new policy applies to each user after their active sessions stop. Existing sessions continue with their current policy.');
  });
});
