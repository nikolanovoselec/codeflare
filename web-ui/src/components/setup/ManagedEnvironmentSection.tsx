import { Show, type Component } from 'solid-js';
import Checkbox from '../ui/Checkbox';
import Input from '../ui/Input';
import SetupSection from './SetupSection';
import type {
  ManagedEnvironmentFreshness,
  ManagedEnvironmentPatExpiryState,
} from '../../stores/setup-types';

interface ManagedEnvironmentSectionProps {
  enabled: boolean;
  enterpriseMode: boolean;
  immutableResources: boolean;
  disableUserCreatedResources: boolean;
  repository: string;
  personalAccessToken: string;
  personalAccessTokenSet: boolean;
  publicKey: string;
  publicKeyFingerprint: string;
  activeReleaseTag?: string;
  activeSequence?: number | null;
  activeDigestPrefix?: string;
  freshness: ManagedEnvironmentFreshness;
  lastCheckedAt?: string;
  patExpiryState: ManagedEnvironmentPatExpiryState;
  lastError?: string;
  onEnabledChange: (value: boolean) => void;
  onImmutableResourcesChange: (value: boolean) => void;
  onDisableUserCreatedResourcesChange: (value: boolean) => void;
  onRepositoryChange: (value: string) => void;
  onPersonalAccessTokenChange: (value: string) => void;
  onPublicKeyChange: (value: string) => void;
}

const ManagedEnvironmentSection: Component<ManagedEnvironmentSectionProps> = (props) => (
  <div data-testid="managed-environment-section">
    <SetupSection
      title="Managed Environment"
      description="Verify and apply signed company agent configuration releases from one private GitHub repository."
    >
      <div class="setup-field">
        <Checkbox
          label="Enable Managed Environment"
          checked={props.enabled}
          onChange={props.onEnabledChange}
        />
      </div>

      <Show when={props.enabled}>
        <Show when={props.enterpriseMode}>
          <div class="setup-field setup-field--nested">
            <Checkbox
              label="Immutable Resources"
              checked={props.immutableResources}
              onChange={props.onImmutableResourcesChange}
            />
            <p class="setup-field-description">
              Managed files stay editable inside the current session, but their mutations cannot persist to R2. Protected edits are lost when the container is replaced.
            </p>
          </div>

          <Show when={props.immutableResources}>
            <div class="setup-field setup-field--nested setup-field--nested-deeper">
              <Checkbox
                label="Disable User Created Resources"
                checked={props.disableUserCreatedResources}
                onChange={props.onDisableUserCreatedResourcesChange}
              />
              <p class="setup-field-description">
                Existing personal agent resources in governed skills, extensions, rules, hooks, scripts, plugins, prompts, commands, agents, and exceptions folders are deleted during reconciliation. New ones remain local and disappear after termination.
              </p>
            </div>
          </Show>
        </Show>

        <div class="setup-field">
          <label class="setup-field-label">Release repository</label>
          <p class="setup-field-description">Private GitHub repository in owner/name form.</p>
          <Input
            value={props.repository}
            onInput={props.onRepositoryChange}
            placeholder="company/codeflare-curation"
          />
        </div>

        <div class="setup-field">
          <label class="setup-field-label">Repository read PAT</label>
          <p class="setup-field-description">
            Fine-grained repository token with Contents: read and Metadata: read. It is encrypted and never returned.
            <Show when={props.personalAccessTokenSet}> A token is already saved; leave blank to preserve it.</Show>
          </p>
          <Input
            type="password"
            value={props.personalAccessToken}
            onInput={props.onPersonalAccessTokenChange}
            placeholder={props.personalAccessTokenSet ? 'Saved — enter a new PAT to replace' : 'github_pat_...'}
          />
        </div>

        <div class="setup-field">
          <label class="setup-field-label">Ed25519 verification key</label>
          <p class="setup-field-description">
            Raw 32-byte public key as 64 lowercase hexadecimal characters.
            <Show when={props.publicKeyFingerprint}> Current fingerprint: {props.publicKeyFingerprint}. Leave blank to preserve it, or enter a replacement after publishing a seed signed by the new key.</Show>
          </p>
          <Input
            value={props.publicKey}
            onInput={props.onPublicKeyChange}
            placeholder={props.publicKeyFingerprint ? 'Saved — enter a new key to replace' : '64 lowercase hex characters'}
          />
        </div>

        <Show when={props.activeSequence !== undefined && props.activeSequence !== null}>
          <div class="setup-field" data-testid="managed-environment-status">
            <p class="setup-field-description">
              Active {props.activeReleaseTag || 'release'} · sequence {props.activeSequence}
              <Show when={props.activeDigestPrefix}> · digest {props.activeDigestPrefix}</Show>
            </p>
            <p class="setup-field-description">
              Freshness: {props.freshness}
              <Show when={props.lastCheckedAt}> · checked {props.lastCheckedAt}</Show>
              {' · '}PAT: {props.patExpiryState}
            </p>
            <Show when={props.lastError}>
              <p class="setup-field-description setup-field-description--error">{props.lastError}</p>
            </Show>
          </div>
        </Show>
      </Show>
    </SetupSection>
  </div>
);

export default ManagedEnvironmentSection;
