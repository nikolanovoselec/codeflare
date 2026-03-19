/**
 * Standalone admin page for managing subscription tier configuration.
 * Tier dropdown to select one tier, then edit that tier's config.
 * Paid tiers have normal + advanced pricing flavors.
 */
import { Component, createSignal, createMemo, onMount, Show } from 'solid-js';
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
  trialQuotaHours?: number;
  trialDays?: number; // backward compat
  description: string;
  advancedPriceMonthly?: number | null;
}

const EDITABLE_TIERS = new Set(['free', 'trial', 'standard', 'advanced', 'max', 'unlimited']);

const SubscriptionManagement: Component<SubManagementProps> = (props) => {
  const [allTiers, setAllTiers] = createSignal<TierConfig[]>([]);
  const [selectedTierId, setSelectedTierId] = createSignal<string>('free');
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal(false);

  onMount(async () => {
    try {
      const data = await getTiers();
      setAllTiers(data.tiers as TierConfig[]);
      const firstEditable = data.tiers.find((t) => EDITABLE_TIERS.has(t.id));
      if (firstEditable) setSelectedTierId(firstEditable.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tier config');
    }
    setLoading(false);
  });

  const editableTiers = () => allTiers().filter((t) => EDITABLE_TIERS.has(t.id));
  const selectedTier = createMemo(() => allTiers().find((t) => t.id === selectedTierId()) ?? null);

  const updateField = (field: string, value: unknown) => {
    setAllTiers((prev) =>
      prev.map((t) => t.id === selectedTierId() ? { ...t, [field]: value } : t)
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

  const dollarsFromCents = (cents: number | null | undefined): string => {
    if (cents === null || cents === undefined || cents === 0) return '0';
    return (cents / 100).toFixed(2);
  };

  const centsToDollars = (dollars: string): number | null => {
    if (dollars === '' || dollars === '0') return 0;
    const n = parseFloat(dollars);
    return isNaN(n) ? null : Math.round(n * 100);
  };

  const hasAdvancedMode = () => {
    const t = selectedTier();
    return t && t.sessionModes.includes('advanced');
  };

  return (
    <div class="sub-mgmt">
      <div class="sub-mgmt-header">
        <button type="button" class="sub-mgmt-back" onClick={props.onBack} title="Back to dashboard">
          <Icon path={mdiArrowExpandLeft} size={18} />
        </button>
        <h1 class="sub-mgmt-title">Subscription Management</h1>
      </div>

      <Show when={!loading()} fallback={<p class="sub-mgmt-loading">Loading...</p>}>
        <Show when={error()}>
          <div class="sub-mgmt-error">{error()}</div>
        </Show>

        {/* Tier selector dropdown */}
        <div class="sub-mgmt-selector">
          <label class="sub-mgmt-selector-label">Select tier</label>
          <select
            class="sub-mgmt-select"
            value={selectedTierId()}
            onChange={(e) => setSelectedTierId(e.currentTarget.value)}
          >
            {editableTiers().map((t) => (
              <option value={t.id}>{t.displayName}</option>
            ))}
          </select>
        </div>

        {/* Selected tier editor — use direct accessors to avoid Show re-mount on edit */}
        <Show when={selectedTier()}>
          <div class="sub-mgmt-editor">
            <div class="sub-mgmt-form">
              <label class="sub-mgmt-field">
                <span class="sub-mgmt-label">Monthly Hours</span>
                <input
                  type="text"
                  class="sub-mgmt-input"
                  value={hoursFromSeconds(selectedTier()!.monthlySeconds)}
                  disabled={selectedTierId() === 'unlimited'}
                  onInput={(e) => updateField('monthlySeconds', secondsFromHours(e.currentTarget.value))}
                />
              </label>

              <label class="sub-mgmt-field">
                <span class="sub-mgmt-label">Max Sessions</span>
                <input
                  type="number"
                  class="sub-mgmt-input"
                  min="0"
                  max="100"
                  value={selectedTier()!.maxSessions}
                  onInput={(e) => updateField('maxSessions', parseInt(e.currentTarget.value) || 0)}
                />
              </label>

              <label class="sub-mgmt-field">
                <span class="sub-mgmt-label">Normal Price ($/mo)</span>
                <input
                  type="text"
                  class="sub-mgmt-input"
                  value={dollarsFromCents(selectedTier()!.priceMonthly)}
                  placeholder="0 = free"
                  onInput={(e) => updateField('priceMonthly', centsToDollars(e.currentTarget.value))}
                />
              </label>

              <label class="sub-mgmt-field">
                <span class="sub-mgmt-label">Advanced Mode</span>
                <div class="sub-mgmt-checkbox-row">
                  <input
                    type="checkbox"
                    checked={selectedTier()!.sessionModes.includes('advanced')}
                      onChange={(e) => {
                        const modes = e.currentTarget.checked
                          ? ['default', 'advanced']
                          : ['default'];
                        updateField('sessionModes', modes);
                      }}
                    />
                    <span class="sub-mgmt-hint">Enable advanced session mode</span>
                  </div>
                </label>

                <Show when={hasAdvancedMode()}>
                  <label class="sub-mgmt-field">
                    <span class="sub-mgmt-label">Advanced Price ($/mo)</span>
                    <input
                      type="text"
                      class="sub-mgmt-input"
                      value={dollarsFromCents(selectedTier()!.advancedPriceMonthly ?? selectedTier()!.priceMonthly)}
                      placeholder="Same as normal"
                      onInput={(e) => updateField('advancedPriceMonthly', centsToDollars(e.currentTarget.value))}
                    />
                    <span class="sub-mgmt-hint">Higher price for advanced mode</span>
                  </label>
                </Show>

                <label class="sub-mgmt-field">
                  <span class="sub-mgmt-label">Trial Quota (hours)</span>
                  <input
                    type="number"
                    class="sub-mgmt-input"
                    min="0"
                    max="10000"
                    value={selectedTier()!.trialQuotaHours ?? selectedTier()!.trialDays ?? 0}
                    onInput={(e) => updateField('trialQuotaHours', parseInt(e.currentTarget.value) || 0)}
                  />
                </label>

                <label class="sub-mgmt-field sub-mgmt-field--full">
                  <span class="sub-mgmt-label">Description</span>
                  <input
                    type="text"
                    class="sub-mgmt-input sub-mgmt-input--wide"
                    value={selectedTier()!.description}
                    placeholder="Shown on subscribe page"
                    maxLength={200}
                    onInput={(e) => updateField('description', e.currentTarget.value)}
                  />
                </label>
            </div>
          </div>
        </Show>

        <div class="sub-mgmt-actions">
          <button
            type="button"
            class="sub-mgmt-save"
            disabled={saving()}
            onClick={handleSave}
          >
            {saving() ? 'Saving...' : 'Save'}
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
