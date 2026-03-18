/**
 * Admin settings section for managing subscription tier configuration.
 * Allows editing monthly hours, max sessions, and session modes for each
 * configurable tier (free, trial, standard, advanced, max, unlimited).
 * Blocked and pending tiers are fixed and not editable.
 */
import { Component, createSignal, onMount, For, Show } from 'solid-js';
import { getTiers, updateTiers } from '../../api/client';

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
}

const EDITABLE_TIERS = new Set(['free', 'trial', 'standard', 'advanced', 'max', 'unlimited']);

const SubscriptionManagement: Component = () => {
  const [tiers, setTiers] = createSignal<TierConfig[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal(false);

  onMount(async () => {
    try {
      const data = await getTiers();
      setTiers(data.tiers);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tier config');
    }
    setLoading(false);
  });

  const editableTiers = () => tiers().filter((t) => EDITABLE_TIERS.has(t.id));

  const updateTier = (id: string, field: string, value: unknown) => {
    setTiers((prev) =>
      prev.map((t) => t.id === id ? { ...t, [field]: value } : t)
    );
    setSuccess(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateTiers(tiers());
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    }
    setSaving(false);
  };

  const hoursFromSeconds = (seconds: number | null): string => {
    if (seconds === null) return '';
    return String(seconds / 3600);
  };

  const secondsFromHours = (hours: string): number | null => {
    if (hours === '' || hours === 'unlimited') return null;
    const n = parseFloat(hours);
    return isNaN(n) ? 0 : Math.round(n * 3600);
  };

  return (
    <div class="settings-section-body">
      <Show when={!loading()} fallback={<p>Loading tier configuration...</p>}>
        <Show when={error()}>
          <p class="settings-error">{error()}</p>
        </Show>

        <div class="settings-tier-table">
          <For each={editableTiers()}>
            {(tier) => (
              <div class="settings-tier-row">
                <div class="settings-tier-name">{tier.displayName}</div>
                <div class="settings-tier-fields">
                  <label class="settings-tier-field">
                    <span>Hours/mo</span>
                    <input
                      type="text"
                      value={tier.monthlySeconds === null ? 'unlimited' : hoursFromSeconds(tier.monthlySeconds)}
                      disabled={tier.id === 'unlimited'}
                      onInput={(e) => {
                        const val = e.currentTarget.value;
                        updateTier(tier.id, 'monthlySeconds', secondsFromHours(val));
                      }}
                    />
                  </label>
                  <label class="settings-tier-field">
                    <span>Sessions</span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={tier.maxSessions}
                      onInput={(e) => updateTier(tier.id, 'maxSessions', parseInt(e.currentTarget.value) || 0)}
                    />
                  </label>
                  <label class="settings-tier-field">
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
                </div>
              </div>
            )}
          </For>
        </div>

        <div class="settings-tier-actions">
          <button
            type="button"
            class="settings-btn-primary"
            disabled={saving()}
            onClick={handleSave}
          >
            {saving() ? 'Saving...' : 'Save Tier Configuration'}
          </button>
          <Show when={success()}>
            <span class="settings-success">Saved</span>
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default SubscriptionManagement;
