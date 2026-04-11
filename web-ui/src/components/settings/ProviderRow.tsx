// Implements REQ-AGENT-010
import { Component, Show, For, createSignal, JSX } from 'solid-js';
import { mdiAlertCircleOutline } from '@mdi/js';
import Icon from '../Icon';
import type { ScopeTier, TierConfig } from '../../lib/token-scopes';

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
    <div class="provider-row" data-testid={props.testId}>
      {/* Connected state */}
      <Show when={props.connected}>
        <div class="provider-row-connected">
          <span class="provider-row-icon">
            <ProviderIcon size={28} />
          </span>
          <span class="provider-row-name">{props.name}</span>
          <span class="provider-row-badge" data-testid={props.testId ? `${props.testId}-badge` : undefined}>
            Connected
          </span>
          <button
            type="button"
            class="provider-row-disconnect"
            onClick={() => props.onDisconnect()}
            disabled={props.disconnecting}
          >
            {props.disconnecting ? 'Disconnecting...' : 'Disconnect'}
          </button>
        </div>
        <Show when={props.message}>
          <span class="provider-row-message">{props.message}</span>
        </Show>
      </Show>

      {/* Disconnected — collapsed: branded Connect button */}
      <Show when={!props.connected && !expanded()}>
        <button
          type="button"
          class="provider-row-connect-btn"
          style={{ background: props.brandColor || 'var(--color-bg-tertiary)' }}
          onClick={handleConnect}
        >
          <ProviderIcon size={24} fill="white" />
          <span>Connect to {props.name}</span>
        </button>
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
                  class="provider-row-connect-btn"
                  style={{ background: props.brandColor || 'var(--color-bg-tertiary)', "text-decoration": "none", "text-align": "center" }}
                  href={resolvedUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid={props.testId ? `${props.testId}-create-token` : undefined}
                >
                  <ProviderIcon size={20} fill="white" />
                  <span>Create Token on {props.name}</span>
                </a>
              </>
            )}
          </Show>

          {/* Instructions + link (Cloudflare) */}
          <Show when={!hasTiers() && hasInstructions()}>
            <div class="provider-row-instructions">{props.instructions}</div>
            <Show when={props.externalUrl}>
              <a
                class="provider-row-connect-btn"
                style={{ background: props.brandColor || 'var(--color-bg-tertiary)', "text-decoration": "none", "text-align": "center" }}
                href={props.externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-testid={props.testId ? `${props.testId}-open-provider` : undefined}
              >
                <ProviderIcon size={20} fill="white" />
                <span>Open {props.name}</span>
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
              class="provider-row-save-btn"
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
              class="provider-row-cancel"
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
