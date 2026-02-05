import { Component, For, createSignal, onMount } from 'solid-js';
import { setupStore } from '../../stores/setup';
import Button from '../ui/Button';
import Input from '../ui/Input';
import '../../styles/configure-step.css';

const ConfigureStep: Component = () => {
  const [adminEmailInput, setAdminEmailInput] = createSignal('');
  const [regularEmailInput, setRegularEmailInput] = createSignal('');

  // Pre-fill from existing config when re-configuring
  onMount(async () => {
    try {
      await setupStore.loadExistingConfig();
    } catch {
      // Best-effort pre-fill
    }
  });

  const handleAddAdminEmail = () => {
    const email = adminEmailInput().trim().toLowerCase();
    if (email && /.+@.+\..+/.test(email) && !setupStore.adminUsers.includes(email)) {
      setupStore.addAdminUser(email);
      setAdminEmailInput('');
    }
  };

  const handleAddRegularEmail = () => {
    const email = regularEmailInput().trim().toLowerCase();
    if (email && /.+@.+\..+/.test(email) && !setupStore.allowedUsers.includes(email)) {
      setupStore.addAllowedUser(email);
      setRegularEmailInput('');
    }
  };

  return (
    <div class="configure-step">
      <h2 class="configure-title">Configure Your Instance</h2>

      {/* Custom Domain (Required) */}
      <div class="setup-field">
        <label class="setup-field-label">Custom Domain</label>
        <p class="setup-field-description">
          Your Cloudflare Access-protected domain (e.g., claude.example.com)
        </p>
        <Input
          value={setupStore.customDomain}
          onInput={(value) => setupStore.setCustomDomain(value)}
          placeholder="claude.example.com"
        />
      </div>

      {/* Admin Users (Required) */}
      <div class="setup-field">
        <label class="setup-field-label">Admin Users</label>
        <p class="setup-field-description">
          Full access including user management
        </p>
        <div class="email-input-row">
          <Input
            value={adminEmailInput()}
            onInput={(value) => setAdminEmailInput(value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddAdminEmail(); } }}
            placeholder="admin@example.com"
          />
          <Button onClick={handleAddAdminEmail} variant="secondary" size="sm">
            Add
          </Button>
        </div>
        <div class="email-tags">
          <For each={setupStore.adminUsers}>
            {(email) => (
              <span class="email-tag email-tag--admin">
                {email}
                <button
                  type="button"
                  class="email-tag-remove"
                  onClick={() => setupStore.removeAdminUser(email)}
                >
                  x
                </button>
              </span>
            )}
          </For>
        </div>
      </div>

      {/* Regular Users (Optional) */}
      <div class="setup-field">
        <label class="setup-field-label">Regular Users</label>
        <p class="setup-field-description">
          Can use Codeflare but cannot manage users
        </p>
        <div class="email-input-row">
          <Input
            value={regularEmailInput()}
            onInput={(value) => setRegularEmailInput(value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddRegularEmail(); } }}
            placeholder="user@example.com"
          />
          <Button onClick={handleAddRegularEmail} variant="secondary" size="sm">
            Add
          </Button>
        </div>
        <div class="email-tags">
          <For each={setupStore.allowedUsers}>
            {(email) => (
              <span class="email-tag">
                {email}
                <button
                  type="button"
                  class="email-tag-remove"
                  onClick={() => setupStore.removeAllowedUser(email)}
                >
                  x
                </button>
              </span>
            )}
          </For>
        </div>
      </div>

      {/* Navigation */}
      <div class="setup-actions">
        <Button onClick={() => setupStore.prevStep()} variant="ghost">
          Back
        </Button>
        <Button
          onClick={() => setupStore.nextStep()}
          disabled={!setupStore.customDomain || setupStore.adminUsers.length === 0}
        >
          Continue
        </Button>
      </div>

    </div>
  );
};

export default ConfigureStep;
