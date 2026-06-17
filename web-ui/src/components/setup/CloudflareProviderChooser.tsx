import { Component } from 'solid-js';
import Input from '../ui/Input';

interface CloudflareProviderChooserProps {
  clientId: string;
  clientSecret: string;
  clientSecretSet: boolean;
  onClientIdChange: (v: string) => void;
  onClientSecretChange: (v: string) => void;
}

/**
 * Connect-to-Cloudflare OAuth client chooser (admin, non-enterprise). The admin
 * registers ONE OAuth client on the operator's Cloudflare account; each user then
 * authorizes their OWN account via the "Connect to Cloudflare" button. The client
 * secret is a password field, masked once saved; leaving it blank keeps the stored
 * secret (no clobber). Mirrors GitHubProviderChooser.
 */
const CloudflareProviderChooser: Component<CloudflareProviderChooserProps> = (props) => (
  <div class="setup-field" data-testid="cloudflare-provider-chooser">
    <label class="setup-field-label">Cloudflare Integration</label>
    <p class="setup-field-description">
      Let users connect their Cloudflare account to deploy, without pasting API tokens. Register an OAuth client on your Cloudflare account and enter its client ID + secret. The client secret is stored encrypted.
    </p>
    <Input
      value={props.clientId}
      onInput={(v) => props.onClientIdChange(v)}
      placeholder="Cloudflare OAuth Client ID"
    />
    <Input
      type="password"
      value={props.clientSecret}
      onInput={(v) => props.onClientSecretChange(v)}
      placeholder={props.clientSecretSet ? 'Saved — enter a new secret to replace' : 'Cloudflare OAuth Client Secret'}
    />
  </div>
);

export default CloudflareProviderChooser;
