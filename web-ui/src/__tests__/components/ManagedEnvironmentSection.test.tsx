import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ManagedEnvironmentSection from '../../components/setup/ManagedEnvironmentSection';

afterEach(cleanup);

describe('Managed coding environment Setup section', () => {
  it('routes repository, PAT, and public-key replacements without exposing saved values', async () => {
    const onEnabledChange = vi.fn();
    const onRepositoryChange = vi.fn();
    const onPersonalAccessTokenChange = vi.fn();
    const onPublicKeyChange = vi.fn();
    const view = render(() => (
      <ManagedEnvironmentSection
        enabled
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
        onRepositoryChange={onRepositoryChange}
        onPersonalAccessTokenChange={onPersonalAccessTokenChange}
        onPublicKeyChange={onPublicKeyChange}
      />
    ));

    const section = view.getByTestId('managed-environment-section');
    const inputs = section.querySelectorAll('input');
    expect(inputs).toHaveLength(4);
    expect(inputs[2].type).toBe('password');
    expect(inputs[2].value).toBe('');
    expect(inputs[2].placeholder).toMatch(/saved/i);
    expect(inputs[3].disabled).toBe(false);
    expect(inputs[3].placeholder).toMatch(/replace/i);
    expect(section).not.toHaveTextContent('github_pat');
    expect(section).toHaveTextContent('Active release-7 · sequence 7 · digest 123456789abc');
    expect(section).toHaveTextContent('checked 2026-08-18T00:00:00.000Z');
    expect(section).toHaveTextContent('Last refresh used the verified cache');

    await fireEvent.input(inputs[1], { target: { value: 'other/repository' } });
    await fireEvent.input(inputs[2], { target: { value: 'replacement-pat' } });
    await fireEvent.input(inputs[3], { target: { value: 'ab'.repeat(32) } });
    expect(onRepositoryChange).toHaveBeenCalledWith('other/repository');
    expect(onPersonalAccessTokenChange).toHaveBeenCalledWith('replacement-pat');
    expect(onPublicKeyChange).toHaveBeenCalledWith('ab'.repeat(32));
  });

  it('keeps trust inputs absent while disabled and emits the disable transition', async () => {
    const onEnabledChange = vi.fn();
    const view = render(() => (
      <ManagedEnvironmentSection
        enabled={false}
        repository=""
        personalAccessToken=""
        personalAccessTokenSet={false}
        publicKey=""
        publicKeyFingerprint=""
        freshness="unconfigured"
        patExpiryState="unknown"
        onEnabledChange={onEnabledChange}
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
});
