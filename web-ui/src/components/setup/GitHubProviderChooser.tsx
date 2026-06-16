import { Component, Show } from 'solid-js';
import Input from '../ui/Input';
import Select from '../ui/Select';

interface GitHubProviderChooserProps {
  providerType: 'app' | 'oauth';
  appClientId: string;
  appClientSecret: string;
  appClientSecretSet: boolean;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthClientSecretSet: boolean;
  onProviderTypeChange: (t: 'app' | 'oauth') => void;
  onAppClientIdChange: (v: string) => void;
  onAppClientSecretChange: (v: string) => void;
  onOauthClientIdChange: (v: string) => void;
  onOauthClientSecretChange: (v: string) => void;
}

const PROVIDER_OPTIONS = [
  { value: 'app', label: 'GitHub App (recommended for EMU)' },
  { value: 'oauth', label: 'OAuth App (non-EMU)' },
];

/**
 * REQ-GITHUB-008: enterprise GitHub provider chooser. The admin picks GitHub App
 * (Entra-provisioned managed users / EMU) or OAuth App (non-EMU) and enters the
 * matching client id + secret. The secret is a password field, masked once saved;
 * leaving it blank keeps the stored secret (no clobber).
 */
const GitHubProviderChooser: Component<GitHubProviderChooserProps> = (props) => (
  <div class="setup-field">
    <label class="setup-field-label">GitHub Integration</label>
    <p class="setup-field-description">
      Let users connect their GitHub account to clone, push, and open PRs. Register a GitHub App inside your enterprise for Entra-provisioned managed users (EMU); use an OAuth App only for non-EMU organizations. The client secret is stored encrypted.
    </p>
    <Select
      class="github-provider-select"
      value={props.providerType}
      options={PROVIDER_OPTIONS}
      onChange={(v) => props.onProviderTypeChange(v as 'app' | 'oauth')}
    />
    <Show when={props.providerType === 'app'}>
      <Input
        value={props.appClientId}
        onInput={(v) => props.onAppClientIdChange(v)}
        placeholder="GitHub App Client ID"
      />
      <Input
        type="password"
        value={props.appClientSecret}
        onInput={(v) => props.onAppClientSecretChange(v)}
        placeholder={props.appClientSecretSet ? 'Saved — enter a new secret to replace' : 'GitHub App Client Secret'}
      />
    </Show>
    <Show when={props.providerType === 'oauth'}>
      <Input
        value={props.oauthClientId}
        onInput={(v) => props.onOauthClientIdChange(v)}
        placeholder="OAuth App Client ID"
      />
      <Input
        type="password"
        value={props.oauthClientSecret}
        onInput={(v) => props.onOauthClientSecretChange(v)}
        placeholder={props.oauthClientSecretSet ? 'Saved — enter a new secret to replace' : 'OAuth App Client Secret'}
      />
    </Show>
  </div>
);

export default GitHubProviderChooser;
