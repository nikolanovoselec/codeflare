import { Component, Accessor, Show } from 'solid-js';
import { mdiPaletteOutline } from '@mdi/js';
import Icon from '../Icon';
import Button from '../ui/Button';
import { applyAccentColor, isValidHex } from '../../lib/settings';
import type { Settings } from '../../lib/settings';
import { isTouchDevice, isSamsungBrowser } from '../../lib/mobile';

const DEFAULT_ACCENT_HEX = '#3b82f6';

interface AppearanceSectionProps {
  accentHexInput: Accessor<string>;
  setAccentHexInput: (value: string) => void;
  showTips: Accessor<boolean>;
  showButtonLabels: Accessor<boolean>;
  samsungAddressBarTop: Accessor<boolean>;
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

const AppearanceSection: Component<AppearanceSectionProps> = (props) => {
  return (
    <>
      {/* Accent Color */}
      <section class="settings-section">
        <div class="settings-section-header">
          <Icon path={mdiPaletteOutline} size={16} />
          <h3 class="settings-section-title">Accent Color</h3>
        </div>
        <p class="settings-hint" style={{ "margin-bottom": "var(--space-2)" }}>
          Customize the UI accent color
        </p>
        <div class="accent-color-row">
          <span
            class="accent-color-swatch"
            style={{
              background: props.accentHexInput() && isValidHex(props.accentHexInput())
                ? (props.accentHexInput().startsWith('#') ? props.accentHexInput() : `#${props.accentHexInput()}`)
                : DEFAULT_ACCENT_HEX,
            }}
            data-testid="accent-color-swatch"
          />
          <input
            type="text"
            class="accent-color-input"
            value={props.accentHexInput()}
            placeholder={DEFAULT_ACCENT_HEX}
            maxLength={7}
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck={false}
            onInput={(e) => {
              const val = e.currentTarget.value;
              props.setAccentHexInput(val);
              if (isValidHex(val)) {
                const normalized = val.startsWith('#') ? val : `#${val}`;
                applyAccentColor(normalized);
                props.updateSetting('accentColor', normalized);
              }
            }}
            data-testid="accent-color-input"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              props.setAccentHexInput('');
              applyAccentColor(undefined);
              props.updateSetting('accentColor', undefined as unknown as Settings['accentColor']);
            }}
            data-testid="accent-color-reset"
          >
            Reset
          </Button>
        </div>
        <a
          class="accent-color-link"
          href="https://htmlcolorcodes.com/color-picker/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Find colors at htmlcolorcodes.com
        </a>
      </section>

      {/* Tips & Tricks */}
      <section class="settings-section">
        <div class="setting-row setting-row--clickable" onClick={(e) => {
          if (!(e.target as HTMLElement).closest('.toggle')) props.updateSetting('showTips', !props.showTips());
        }}>
          <label for="settings-show-tips">Show tips on dashboard</label>
          <button
            type="button"
            id="settings-show-tips"
            class={`toggle ${props.showTips() ? 'toggle-on' : ''}`}
            onClick={() => props.updateSetting('showTips', !props.showTips())}
            role="switch"
            aria-checked={props.showTips()}
            data-testid="settings-show-tips-toggle"
          >
            <span class="toggle-thumb" />
          </button>
        </div>
        <div class="setting-row setting-row--column-gap">
          <span class="settings-hint">
            Show rotating tips & tricks on the dashboard. When disabled, a welcome card is shown instead.
          </span>
        </div>
      </section>

      {/* Button Labels -- mobile only */}
      <Show when={isTouchDevice()}>
        <section class="settings-section">
          <div class="setting-row setting-row--clickable" onClick={(e) => {
            if (!(e.target as HTMLElement).closest('.toggle')) props.updateSetting('showButtonLabels', !props.showButtonLabels());
          }}>
            <label for="settings-button-labels">Show button labels</label>
            <button
              type="button"
              id="settings-button-labels"
              class={`toggle ${props.showButtonLabels() ? 'toggle-on' : ''}`}
              onClick={() => props.updateSetting('showButtonLabels', !props.showButtonLabels())}
              role="switch"
              aria-checked={props.showButtonLabels()}
              data-testid="settings-button-labels-toggle"
            >
              <span class="toggle-thumb" />
            </button>
          </div>
          <div class="setting-row setting-row--column-gap">
            <span class="settings-hint">
              Briefly show text labels next to floating terminal buttons when the keyboard opens.
            </span>
          </div>
        </section>
      </Show>

      {/* Samsung -- Samsung only */}
      <Show when={isSamsungBrowser}>
        <section class="settings-section">
          <div class="setting-row setting-row--clickable" onClick={(e) => {
            if (!(e.target as HTMLElement).closest('.toggle')) props.updateSetting('samsungAddressBarTop', !props.samsungAddressBarTop());
          }}>
            <label for="settings-samsung-bar-top">Alternative layout</label>
            <button
              type="button"
              id="settings-samsung-bar-top"
              class={`toggle ${props.samsungAddressBarTop() ? 'toggle-on' : ''}`}
              onClick={() => props.updateSetting('samsungAddressBarTop', !props.samsungAddressBarTop())}
              role="switch"
              aria-checked={props.samsungAddressBarTop()}
              data-testid="settings-samsung-bar-top-toggle"
            >
              <span class="toggle-thumb" />
            </button>
          </div>
          <div class="setting-row setting-row--column-gap">
            <span class="settings-hint">
              Enable if floating buttons appear in the wrong position. Adjusts layout for alternative browser configurations.
            </span>
          </div>
        </section>
      </Show>
    </>
  );
};

export default AppearanceSection;
