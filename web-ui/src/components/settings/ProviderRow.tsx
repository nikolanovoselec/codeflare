// Implements REQ-AGENT-010
import { Component, Show, For, createSignal, JSX } from 'solid-js';
import { mdiAlertCircleOutline, mdiOpenInNew, mdiCheck } from '@mdi/js';
import Icon from '../Icon';
import type { ScopeTier, TierConfig } from '../../lib/token-scopes';
import '../../styles/connect.css';

interface ProviderRowProps {
  icon: Component<{ size?: number; class?: string; style?: JSX.CSSProperties; fill?: string }>;
  name: string;
  brandColor?: string;
  externalUrl?: string;
  externalLabel?: string;
  placeholder?: string;
  connected: boolean;
  onSave: (token: string) => void;
  onDisconnect: () => void;
  saving?: boolean;
  disconnecting?: boolean;
  message?: string | null;
  error?: string | null;
  testId?: string;
  children?: JSX.Element;
  /** GitHub-style tier selector. When present, Connect expands instead of opening URL. */
  tierOptions?: {
    tiers: Record<ScopeTier, TierConfig>;
    getUrl: (tier: ScopeTier) => string;
    docsUrl?: string;
  };
  /** Instruction JSX shown in expanded section (e.g., Cloudflare template guidance). */
  instructions?: JSX.Element;
}

const TIER_ORDER: ScopeTier[] = ['minimal', 'recommended', 'advanced'];

const ProviderRow: Component<ProviderRowProps> = (props) => {
  const ProviderIcon = props.icon;
  const [expanded, setExpanded] = createSignal(false);
  const [tokenValue, setTokenValue] = createSignal('');
  const [selectedTier, setSelectedTier] = createSignal<ScopeTier>('recommended');

  const hasTiers = () => !!props.tierOptions;
  const hasInstructions = () => !!props.instructions;

  const resolvedUrl = () => {
    if (props.tierOptions) return props.tierOptions.getUrl(selectedTier());
    return props.externalUrl;
  };

  const handleConnect = () => {
    if (hasTiers() || hasInstructions()) {
      // Expand only — user clicks the link manually
      setExpanded(true);
    } else {
      // No tiers or instructions: open URL directly (existing behavior)
      if (props.externalUrl) {
        window.open(props.externalUrl, '_blank');
      }
      setExpanded(true);
    }
    setTokenValue('');
  };

  const handleSave = () => {
    const token = tokenValue().trim();
    if (!token) return;
    props.onSave(token);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') setExpanded(false);
  };

  return (
    <div class="oauth-connect-card settings-connection-card" data-testid={props.testId}>
      <div class="oauth-connect-head">
        <span class="oauth-connect-icon" style={{ color: props.brandColor }} aria-hidden="true">
          <ProviderIcon size={18} />
        </span>
        <span class="oauth-connect-name">{props.name}</span>
        <Show when={props.connected}>
          <span class="settings-connection-status" role="status" data-testid={props.testId ? `${props.testId}-badge` : undefined}>
            <Icon path={mdiCheck} size={14} aria-hidden="true" />Connected
          </span>
        </Show>
      </div>
      <Show when={props.connected && props.children}>
        <div class="oauth-connect-body"><span class="oauth-connect-identity">{props.children}</span></div>
      </Show>
      <Show when={props.connected || !expanded()}>
        <div class="settings-connection-actions">
          <Show when={props.connected}>
            <button
              type="button"
              class="oauth-connect-disconnect"
              onClick={() => props.onDisconnect()}
              disabled={props.disconnecting}
            >
              {props.disconnecting ? 'Disconnecting...' : 'Disconnect'}
            </button>
          </Show>
          <Show when={!props.connected && !expanded()}>
            <button type="button" class="oauth-connect-btn oauth-connect-btn--connect settings-action settings-action--accent" aria-label={`Connect to ${props.name}`} onClick={handleConnect}>Connect</button>
          </Show>
        </div>
      </Show>
      <Show when={props.connected && props.message}>
        <span class="provider-row-message">{props.message}</span>
      </Show>

      {/* Disconnected — expanded: inline connect flow */}
      <Show when={!props.connected && expanded()}>
        <div class="provider-row-expand">
          {/* Tier selector (GitHub) */}
          <Show when={props.tierOptions}>
            {(opts) => (
              <>
                <div
                  class="scope-tier-control"
                  role="radiogroup"
                  aria-label="Token scope"
                  data-testid={props.testId ? `${props.testId}-tier-control` : undefined}
                >
                  <For each={TIER_ORDER}>
                    {(tier) => (
                      <label
                        class={`scope-tier-option ${selectedTier() === tier ? 'scope-tier-option--selected' : ''}`}
                      >
                        <input
                          type="radio"
                          name={`scope-tier-${props.name}`}
                          value={tier}
                          checked={selectedTier() === tier}
                          onChange={() => setSelectedTier(tier)}
                          data-testid={props.testId ? `${props.testId}-tier-${tier}` : undefined}
                        />
                        {opts().tiers[tier].label}
                      </label>
                    )}
                  </For>
                </div>
                <p class="scope-tier-description" data-testid={props.testId ? `${props.testId}-tier-desc` : undefined}>
                  {opts().tiers[selectedTier()].description}
                </p>
                <a
                  class="settings-action settings-action--accent provider-row-connect-btn"
                  href={resolvedUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid={props.testId ? `${props.testId}-create-token` : undefined}
                >
                  <span>Create Token on {props.name}</span>
                  <Icon path={mdiOpenInNew} size={16} aria-hidden="true" />
                </a>
              </>
            )}
          </Show>

          {/* Instructions + link (Cloudflare) */}
          <Show when={!hasTiers() && hasInstructions()}>
            <div class="provider-row-instructions">{props.instructions}</div>
            <Show when={props.externalUrl}>
              <a
                class="settings-action settings-action--accent provider-row-connect-btn"
                href={props.externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid={props.testId ? `${props.testId}-open-provider` : undefined}
              >
                <span>Open {props.name}</span>
                <Icon path={mdiOpenInNew} size={16} aria-hidden="true" />
              </a>
            </Show>
          </Show>

          {/* Reopen link (only when no tier selector and no instructions) */}
          <Show when={!hasTiers() && !hasInstructions() && props.externalUrl}>
            <a
              class="provider-row-reopen-link"
              href={props.externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={props.testId ? `${props.testId}-external` : undefined}
            >
              Didn't open? Click here to open {props.name}.
            </a>
          </Show>

          <div class="provider-row-input-group">
            <input
              type="password"
              class="provider-row-token-input"
              value={tokenValue()}
              placeholder={props.placeholder || 'Paste token...'}
              autocomplete="off"
              onInput={(e) => setTokenValue(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              data-testid={props.testId ? `${props.testId}-input` : undefined}
            />
            <button
              type="button"
              class="settings-action settings-action--accent provider-row-save-btn"
              disabled={props.saving || !tokenValue().trim()}
              onClick={handleSave}
              data-testid={props.testId ? `${props.testId}-save` : undefined}
            >
              {props.saving ? 'Saving...' : 'Save'}
            </button>
          </div>

          {/* Paste step hint — below input so "paste above" is correct */}
          <p class="provider-row-instructions">Copy the token, return to this page, paste above and save.</p>

          <div class="provider-row-expand-footer">
            <Show when={props.error}>
              <span class="provider-row-error">
                <Icon path={mdiAlertCircleOutline} size={14} /> {props.error}
              </span>
            </Show>
            <Show when={props.message}>
              <span class="provider-row-message">{props.message}</span>
            </Show>
            <Show when={props.tierOptions?.docsUrl}>
              <a
                class="scope-tier-docs-link"
                href={props.tierOptions!.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                See all scopes
              </a>
            </Show>
            <Show when={hasTiers()}>
              <span class="provider-row-hint">You can adjust scopes anytime from your dashboard.</span>
            </Show>
            <button
              type="button"
              class="settings-action provider-row-cancel"
              onClick={() => setExpanded(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default ProviderRow;
