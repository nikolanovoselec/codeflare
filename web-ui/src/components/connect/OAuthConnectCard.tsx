import { Component, Show, For } from 'solid-js';
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
  /** 'github' | 'cloudflare' — scopes every data-testid so a page with both is unambiguous. */
  provider: string;
  /** mdi icon path. */
  icon: string;
  /** Display name (passed in — the component embeds no provider copy). */
  name: string;
  status: OAuthConnectStatus;
  /** Base connect endpoint; the tier (when present) is appended as `?tier=`. */
  connectUrl: string;
  onDisconnect: () => void;
  /** Connected identity (GitHub login / Cloudflare account name). */
  identity?: string;
  /** Scope-tier selector shown in the disconnected state; feeds the OAuth scope param. */
  tierOptions?: OAuthTierOptions;
  /** Account picker shown in the connected state (Cloudflare multi-account). */
  accounts?: OAuthAccountOption[];
  selectedAccountId?: string;
  onSelectAccount?: (id: string) => void;
}

/**
 * One connect card for an OAuth-connected provider (GitHub / Cloudflare), reused by
 * the dashboard panel, the Guided Setup onboarding, and the Settings accordion.
 * Connect is a top-level browser navigation (the Worker 302s to the provider and
 * returns to the app), so the connect button assigns window.location.href rather
 * than calling fetch — popup-blocker-safe because it fires in the click gesture.
 */
const OAuthConnectCard: Component<OAuthConnectCardProps> = (props) => {
  const href = () => {
    if (!props.tierOptions) return props.connectUrl;
    const sep = props.connectUrl.includes('?') ? '&' : '?';
    return `${props.connectUrl}${sep}tier=${encodeURIComponent(props.tierOptions.selected)}`;
  };

  return (
    <div class="oauth-connect-card" data-testid={`${props.provider}-connect-card`} data-status={props.status}>
      <div class="oauth-connect-head">
        <Icon path={props.icon} size={28} class="oauth-connect-icon" />
        <span class="oauth-connect-name">{props.name}</span>
        <Show when={props.status === 'connected'}>
          <span class="oauth-connect-badge" data-testid={`${props.provider}-connected-badge`}>Connected</span>
          <button
            type="button"
            class="oauth-connect-disconnect"
            data-testid={`${props.provider}-disconnect-btn`}
            onClick={() => props.onDisconnect()}
          >
            Disconnect
          </button>
        </Show>
      </div>

      <Show when={props.status === 'connected'}>
        <Show when={props.identity || (props.accounts && props.accounts.length > 0)}>
          <div class="oauth-connect-body">
            <Show when={props.identity}>
              <span class="oauth-connect-identity" data-testid={`${props.provider}-identity`}>{props.identity}</span>
            </Show>
            <Show when={props.accounts && props.accounts.length > 0}>
              <Select
                class="oauth-connect-account"
                value={props.selectedAccountId ?? ''}
                options={(props.accounts ?? []).map((a) => ({ value: a.id, label: a.name }))}
                onChange={(v) => props.onSelectAccount?.(v)}
              />
            </Show>
          </div>
        </Show>
      </Show>

      <Show when={props.status === 'connecting'}>
        <div class="oauth-connect-body" data-testid={`${props.provider}-connecting`} aria-busy="true">
          <span class="oauth-connect-spinner" />
        </div>
      </Show>

      <Show when={props.status === 'disconnected'}>
        <div class="oauth-connect-body">
          <Show when={props.tierOptions}>
            {(tier) => (
              <div class="oauth-connect-tier" data-testid={`${props.provider}-tier`}>
                <div class="oauth-connect-tier-control" role="radiogroup" aria-label="Access level">
                  <For each={TIER_ORDER}>
                    {(t) => (
                      <label
                        class={`oauth-connect-tier-option ${tier().selected === t ? 'oauth-connect-tier-option--selected' : ''}`}
                      >
                        <input
                          type="radio"
                          name={`${props.provider}-tier`}
                          value={t}
                          checked={tier().selected === t}
                          onChange={() => tier().onSelect(t)}
                          data-testid={`${props.provider}-tier-${t}`}
                        />
                        {tier().tiers[t].label}
                      </label>
                    )}
                  </For>
                </div>
                <span class="oauth-connect-tier-desc" data-testid={`${props.provider}-tier-desc`}>
                  {tier().tiers[tier().selected].description}
                </span>
              </div>
            )}
          </Show>
          <button
            type="button"
            class="oauth-connect-btn oauth-connect-btn--connect"
            data-testid={`${props.provider}-connect-btn`}
            data-href={href()}
            onClick={() => { window.location.href = href(); }}
          >
            <Icon path={props.icon} size={16} />
            <span>Connect {props.name}</span>
          </button>
        </div>
      </Show>
    </div>
  );
};

export default OAuthConnectCard;
