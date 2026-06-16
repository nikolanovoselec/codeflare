import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@solidjs/testing-library';
import GitHubProviderChooser from '../../components/setup/GitHubProviderChooser';

afterEach(() => cleanup());

const base = {
  providerType: 'app' as 'app' | 'oauth',
  appClientId: '',
  appClientSecret: '',
  appClientSecretSet: false,
  oauthClientId: '',
  oauthClientSecret: '',
  oauthClientSecretSet: false,
  onProviderTypeChange: () => {},
  onAppClientIdChange: () => {},
  onAppClientSecretChange: () => {},
  onOauthClientIdChange: () => {},
  onOauthClientSecretChange: () => {},
};

describe('GitHubProviderChooser', () => {
  it('reveals the App id + secret pair when providerType is app', () => {
    render(() => <GitHubProviderChooser {...base} providerType="app" />);
    expect(screen.getByPlaceholderText('GitHub App Client ID')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('OAuth App Client ID')).not.toBeInTheDocument();
  });

  it('reveals the OAuth id + secret pair when providerType is oauth', () => {
    render(() => <GitHubProviderChooser {...base} providerType="oauth" />);
    expect(screen.getByPlaceholderText('OAuth App Client ID')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('GitHub App Client ID')).not.toBeInTheDocument();
  });

  it('fires onProviderTypeChange when the provider is switched', () => {
    const onProviderTypeChange = vi.fn();
    render(() => <GitHubProviderChooser {...base} onProviderTypeChange={onProviderTypeChange} />);
    const sel = document.querySelector('.github-provider-select') as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: 'oauth' } });
    expect(onProviderTypeChange).toHaveBeenCalledWith('oauth');
  });

  it('routes app client id + secret input to their callbacks', () => {
    const onAppClientIdChange = vi.fn();
    const onAppClientSecretChange = vi.fn();
    render(() => (
      <GitHubProviderChooser
        {...base}
        providerType="app"
        onAppClientIdChange={onAppClientIdChange}
        onAppClientSecretChange={onAppClientSecretChange}
      />
    ));
    fireEvent.input(screen.getByPlaceholderText('GitHub App Client ID'), { target: { value: 'cid' } });
    expect(onAppClientIdChange).toHaveBeenCalledWith('cid');
    const secret = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.input(secret, { target: { value: 'sec' } });
    expect(onAppClientSecretChange).toHaveBeenCalledWith('sec');
  });

  it('drops the unsaved-secret placeholder once a secret is already stored', () => {
    render(() => <GitHubProviderChooser {...base} providerType="app" appClientSecretSet />);
    expect(screen.queryByPlaceholderText('GitHub App Client Secret')).not.toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).not.toBeNull();
  });
});
