/**
 * Standalone admin page for managing subscription tier configuration.
 * Follows the same layout pattern as UserManagement.tsx.
 */
import { Component, createSignal, onMount, For, Show } from 'solid-js';
import { mdiArrowExpandLeft } from '@mdi/js';
import { getTiers, updateTiers } from '../../api/client';
import Icon from '../Icon';
import '../../styles/subscription-management.css';

interface SubManagementProps {
  onBack: () => void;
}

interface TierConfig {
  id: string;
  displayName: string;
  monthlySeconds: number | null;
  maxSessions: number;
  sessionModes: string[];
  canLogin: boolean;
  order: number;
  isDefault: boolean;
  priceMonthly: number | null;
  trialDays: number;
  description: string;
}

const EDITABLE_TIERS = new Set(['free', 'trial', 'standard', 'advanced', 'max', 'unlimited']);

const SubscriptionManagement: Component<SubManagementProps> = (props) => {
  const [allTiers, setAllTiers] = createSignal<TierConfig[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal(false);

  onMount(async () => {
    try {
      const data = await getTiers();
      setAllTiers(data.tiers as TierConfig[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tier config');
    }
    setLoading(false);
  });

  const editableTiers = () => allTiers().filter((t) => EDITABLE_TIERS.has(t.id));

  const updateTier = (id: string, field: string, value: unknown) => {
    setAllTiers((prev) =>
      prev.map((t) => t.id === id ? { ...t, [field]: value } : t)
    );
    setSuccess(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateTiers(allTiers());
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
    setSaving(false);
  };

  const hoursFromSeconds = (seconds: number | null): string => {
    if (seconds === null) return 'unlimited';
    return String(Math.round(seconds / 3600));
  };

  const secondsFromHours = (hours: string): number | null => {
    if (hours === '' || hours === 'unlimited') return null;
    const n = parseFloat(hours);
    return isNaN(n) ? 0 : Math.round(n * 3600);
  };

  const dollarsFromCents = (cents: number | null): string => {
    if (cents === null) return '';
    return String(cents / 100);
  };

  const centsToDollars = (dollars: string): number | null => {
    if (dollars === '') return null;
    const n = parseFloat(dollars);
    return isNaN(n) ? null : Math.round(n * 100);
  };

  return (
    <div class="sub-mgmt">
      <div class="sub-mgmt-header">
        <button type="button" class="sub-mgmt-back" onClick={props.onBack} title="Back to dashboard">
          <Icon path={mdiArrowExpandLeft} size={18} />
        </button>
        <h1 class="sub-mgmt-title">Subscription Management</h1>
      </div>

      <Show when={!loading()} fallback={<p class="sub-mgmt-loading">Loading tier configuration...</p>}>
        <Show when={error()}>
          <div class="sub-mgmt-error">{error()}</div>
        </Show>

        <div class="sub-mgmt-tiers">
          <For each={editableTiers()}>
            {(tier) => (
              <div class="sub-mgmt-tier-card">
                <div class="sub-mgmt-tier-name">{tier.displayName}</div>

                <div class="sub-mgmt-fields">
                  <label class="sub-mgmt-field">
                    <span>Hours/mo</span>
                    <input
                      type="text"
                      value={hoursFromSeconds(tier.monthlySeconds)}
                      disabled={tier.id === 'unlimited'}
                      onInput={(e) => updateTier(tier.id, 'monthlySeconds', secondsFromHours(e.currentTarget.value))}
                    />
                  </label>

                  <label class="sub-mgmt-field">
                    <span>Sessions</span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={tier.maxSessions}
                      onInput={(e) => updateTier(tier.id, 'maxSessions', parseInt(e.currentTarget.value) || 0)}
                    />
                  </label>

                  <label class="sub-mgmt-field">
                    <span>Price ($/mo)</span>
                    <input
                      type="text"
                      value={dollarsFromCents(tier.priceMonthly)}
                      placeholder="0"
                      onInput={(e) => updateTier(tier.id, 'priceMonthly', centsToDollars(e.currentTarget.value))}
                    />
                  </label>

                  <label class="sub-mgmt-field">
                    <span>Trial (days)</span>
                    <input
                      type="number"
                      min="0"
                      max="365"
                      value={tier.trialDays}
                      onInput={(e) => updateTier(tier.id, 'trialDays', parseInt(e.currentTarget.value) || 0)}
                    />
                  </label>

                  <label class="sub-mgmt-field">
                    <span>Advanced mode</span>
                    <input
                      type="checkbox"
                      checked={tier.sessionModes.includes('advanced')}
                      onChange={(e) => {
                        const modes = e.currentTarget.checked
                          ? ['default', 'advanced']
                          : ['default'];
                        updateTier(tier.id, 'sessionModes', modes);
                      }}
                    />
                  </label>

                  <label class="sub-mgmt-field sub-mgmt-field--wide">
                    <span>Description</span>
                    <input
                      type="text"
                      value={tier.description}
                      placeholder="Short description"
                      maxLength={200}
                      onInput={(e) => updateTier(tier.id, 'description', e.currentTarget.value)}
                    />
                  </label>
                </div>
              </div>
            )}
          </For>
        </div>

        <div class="sub-mgmt-actions">
          <button
            type="button"
            class="sub-mgmt-save"
            disabled={saving()}
            onClick={handleSave}
          >
            {saving() ? 'Saving...' : 'Save Configuration'}
          </button>
          <Show when={success()}>
            <span class="sub-mgmt-success">Saved</span>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default SubscriptionManagement;
