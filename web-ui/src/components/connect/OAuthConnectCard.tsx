import { Component, Show, For, createSignal, onCleanup } from 'solid-js';
import { mdiCheck } from '@mdi/js';
import Icon from '../Icon';
import Select from '../ui/Select';
import { type ScopeTier, type TierConfig } from '../../lib/token-scopes';
import '../../styles/connect.css';

const TIER_ORDER: ScopeTier[] = ['minimal', 'recommended', 'advanced'];

export type OAuthConnectStatus = 'disconnected' | 'connecting' | 'connected';

export interface OAuthTierOptions {
  /** Tier catalog (label + description) — drives the tier dropdown + subtitle. */
  tiers: Record<ScopeTier, TierConfig>;
  selected: ScopeTier;
  onSelect: (value: ScopeTier) => void;
}

export interface OAuthAccountOption {
  id: string;
  name: string;
}

interface OAuthConnectCardProps {
  /** Optional surface-specific chrome; connect/disconnect behavior stays shared. */
  class?: string;
  /** Settings keeps account details before compact connection actions. */
  compact?: boolean;
  /** 'github' | 'cloudflare' — scopes every data-testid so a page with both is unambiguous. */
  provider: string;
  /** mdi icon path. */
  icon?: string;
  /** Display name (passed in — the component embeds no provider copy). */
  name: string;
  status: OAuthConnectStatus;
  /** Base connect endpoint; the tier (when present) is appended as `?tier=`. */
  connectUrl: string;
  onDisconnect: () => void;
  /** Connected identity (GitHub login / Cloudflare account name). */
  identity?: string;
  identityLabel?: string;
  /** Non-secret connection selector shown before connecting (for multi-portal cards). */
  description?: string;
  /** Scope-tier selector for Connect, Re-authorize and authorization retry. */
  tierOptions?: OAuthTierOptions;
  /** Guided Setup only: offer a non-destructive retry after an OAuth error. */
  retryAuthorization?: boolean;
  /** Account picker shown in the connected state (Cloudflare multi-account). */
  accounts?: OAuthAccountOption[];
  selectedAccountId?: string;
  onSelectAccount?: (id: string) => void;
  /** Retry reading account choices after an account-selection return. */
  onRetryAccounts?: () => Promise<void>;
}

/**
 * One connect card for an OAuth-connected provider (GitHub / Cloudflare), reused by
 * the dashboard panel, the Guided Setup onboarding, and the Settings accordion.
 * Connect is a top-level browser navigation (the Worker 302s to the provider and
 * returns to the app), so the connect button assigns window.location.href rather
 * than calling fetch — popup-blocker-safe because it fires in the click gesture.
 */
const OAuthConnectCard: Component<OAuthConnectCardProps> = (props) => {
  const [reauthorizing, setReauthorizing] = createSignal(false);
  const [reauthorizationTier, setReauthorizationTier] = createSignal<ScopeTier>();
  const [reloadingAccounts, setReloadingAccounts] = createSignal(false);
  const primaryActionClass = () => props.compact
    ? 'settings-action settings-action--accent' : 'oauth-connect-btn oauth-connect-btn--connect';
  const connectedActionsClass = () => props.compact ? 'settings-connection-actions' : 'oauth-connect-body';
  let reauthorizeButton: HTMLButtonElement | undefined;
  let reauthorizePrompt: HTMLParagraphElement | undefined;
  let accountPicker: HTMLSelectElement | undefined;
  let stopWatchingRetryFocus: (() => void) | undefined;
  onCleanup(() => stopWatchingRetryFocus?.());

  const reloadAccounts = async (button: HTMLButtonElement, retry: () => Promise<void>) => {
    if (reloadingAccounts()) return;
    const doc = button.ownerDocument;
    let keepFocus = doc.activeElement === button;
    const focusMoved = (event: FocusEvent) => {
      if (event.target !== button) keepFocus = false;
    };
    doc.addEventListener('focusin', focusMoved);
    const stopWatching = () => doc.removeEventListener('focusin', focusMoved);
    stopWatchingRetryFocus = stopWatching;
    setReloadingAccounts(true);
    try {
      await retry();
      // A focusable busy button retains focus until the picker replaces it.
      if (keepFocus && !button.isConnected && props.onRetryAccounts && accountPicker?.isConnected
        && doc.activeElement === doc.body) accountPicker.focus();
    } finally {
      stopWatching();
      stopWatchingRetryFocus = undefined;
      setReloadingAccounts(false);
    }
  };

  const href = (tier?: ScopeTier) => {
    if (!tier) return props.connectUrl;
    const sep = props.connectUrl.includes('?') ? '&' : '?';
    return `${props.connectUrl}${sep}tier=${encodeURIComponent(tier)}`;
  };

  const TierSelector: Component<{
    tiers: OAuthTierOptions['tiers'];
    selected?: ScopeTier;
    onSelect: OAuthTierOptions['onSelect'];
  }> = (tier) => (
    <div class="oauth-connect-tier" data-testid={`${props.provider}-tier`}>
      <div class="oauth-connect-tier-control" role="radiogroup" aria-label="Access level">
        <For each={TIER_ORDER}>
          {(t) => (
            <label class={`oauth-connect-tier-option ${tier.selected === t ? 'oauth-connect-tier-option--selected' : ''}`}>
              <input type="radio" name={`${props.provider}-tier`} value={t} checked={tier.selected === t}
                onChange={() => tier.onSelect(t)} data-testid={`${props.provider}-tier-${t}`} />
              {tier.tiers[t].label}
            </label>
          )}
        </For>
      </div>
      <Show when={tier.selected}>
        {(selected) => <span class="oauth-connect-tier-desc" data-testid={`${props.provider}-tier-desc`}>
          {tier.tiers[selected()].description}
        </span>}
      </Show>
    </div>
  );

  const DisconnectButton: Component = () => (
    <button
      type="button"
      class="oauth-connect-disconnect"
      aria-label={props.description ? `Disconnect ${props.name} ${props.description}` : undefined}
      data-testid={`${props.provider}-disconnect-btn`}
      disabled={reloadingAccounts()}
      onClick={() => props.onDisconnect()}
    >
      Disconnect
    </button>
  );

  return (
    <div class={`oauth-connect-card${props.compact ? ' settings-connection-card' : ''}${props.class ? ` ${props.class}` : ''}`} data-testid={`${props.provider}-connect-card`} data-status={props.status}>
      <div class="oauth-connect-head">
        <Show when={props.icon}>{(icon) => <Icon path={icon()} size={28} class="oauth-connect-icon" />}</Show>
        <span class="oauth-connect-name">{props.name}</span>
        <Show when={props.status === 'connected'}>
          <span class={props.compact ? 'settings-connection-status' : 'oauth-connect-badge'}
            role={props.compact ? 'status' : undefined} data-testid={`${props.provider}-connected-badge`}>
            <Show when={props.compact}><Icon path={mdiCheck} size={14} aria-hidden="true" /></Show>Connected
          </span>
          <Show when={!props.compact}><DisconnectButton /></Show>
        </Show>
      </div>

      <Show when={props.status === 'connected'}>
        <Show when={props.identity || (props.accounts && props.accounts.length > 0)}>
          <div class="oauth-connect-body">
            <Show when={props.identity}>
              <div class="oauth-connect-identity">
                <Show when={props.identityLabel}><span class="settings-connection-identity-label">{props.identityLabel}</span></Show>
                <span data-testid={`${props.provider}-identity`}>{props.identity}</span>
              </div>
            </Show>
            <Show when={props.accounts && props.accounts.length > 0}>
              <Select
                class="oauth-connect-account"
                ref={(element) => { accountPicker = element; }}
                ariaLabel={props.compact ? `${props.name} account` : undefined}
                value={props.selectedAccountId ?? ''}
                options={(props.accounts ?? []).map((a) => ({ value: a.id, label: a.name }))}
                onChange={(v) => props.onSelectAccount?.(v)}
              />
            </Show>
          </div>
        </Show>
        <Show when={!props.selectedAccountId && !props.accounts?.length ? props.onRetryAccounts : undefined}>
          {(retry) => <div class="oauth-connect-recovery">
            <p class="oauth-connect-identity" role="status">{props.name} accounts could not be loaded.</p>
            <button type="button" class={primaryActionClass()} aria-disabled={reloadingAccounts()}
              onClick={(event) => { void reloadAccounts(event.currentTarget, retry()); }}>Retry loading accounts</button>
          </div>}
        </Show>
      </Show>

      <Show when={props.status === 'connected' && (props.compact || (props.retryAuthorization && props.tierOptions))}>
        <Show when={reauthorizing() ? props.tierOptions : undefined} fallback={
          <div class={connectedActionsClass()}>
            <Show when={props.tierOptions}>
              <button type="button" class={primaryActionClass()} ref={reauthorizeButton} disabled={reloadingAccounts()}
                onClick={() => {
                  setReauthorizationTier(undefined);
                  setReauthorizing(true);
                  queueMicrotask(() => reauthorizePrompt?.focus());
                }}>{props.compact ? 'Re-authorize' : 'Retry authorization'}</button>
            </Show>
            <Show when={props.compact}><DisconnectButton /></Show>
          </div>
        }>
          {(tier) => <div class="oauth-connect-recovery">
            <p class={props.compact ? 'settings-hint type-hint' : 'oauth-connect-identity'} tabindex={-1} ref={reauthorizePrompt}>
              Choose the access level to request from {props.name}.
            </p>
            <TierSelector tiers={tier().tiers} selected={reauthorizationTier()} onSelect={setReauthorizationTier} />
            <div class={connectedActionsClass()}>
              <button type="button" class={primaryActionClass()} disabled={!reauthorizationTier() || reloadingAccounts()}
                onClick={() => {
                  const selected = reauthorizationTier();
                  if (selected) window.location.href = href(selected);
                }}>Continue to {props.name}</button>
              <button type="button" class={props.compact ? 'settings-action' : 'oauth-connect-btn'} onClick={() => {
                setReauthorizing(false);
                queueMicrotask(() => reauthorizeButton?.focus());
              }}>Cancel</button>
            </div>
          </div>}
        </Show>
      </Show>

      <Show when={props.status === 'connecting'}>
        <div class="oauth-connect-body" data-testid={`${props.provider}-connecting`} aria-busy="true">
          <span class="oauth-connect-spinner" />
        </div>
      </Show>

      <Show when={props.status === 'disconnected'}>
        <div class="oauth-connect-body">
          <Show when={props.description}><span class="oauth-connect-identity">{props.description}</span></Show>
          <Show when={props.tierOptions}>{(tier) => <TierSelector {...tier()} />}</Show>
          <button
            type="button"
            class="oauth-connect-btn oauth-connect-btn--connect"
            aria-label={props.description ? `Connect ${props.name} ${props.description}` : undefined}
            data-testid={`${props.provider}-connect-btn`}
            data-href={href(props.tierOptions?.selected)}
            onClick={() => { window.location.href = href(props.tierOptions?.selected); }}
          >
            <Show when={props.icon}>{(icon) => <Icon path={icon()} size={16} />}</Show>
            <span>Connect {props.name}</span>
          </button>
        </div>
      </Show>
    </div>
  );
};

export default OAuthConnectCard;
