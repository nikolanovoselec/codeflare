import { Component, For, Show, createSignal, onMount } from 'solid-js';
import { setupStore } from '../../stores/setup';
import Button from '../ui/Button';
import Input from '../ui/Input';
import '../../styles/configure-step.css';

const ConfigureStep: Component = () => {
  const [adminEmailInput, setAdminEmailInput] = createSignal('');
  const [regularEmailInput, setRegularEmailInput] = createSignal('');
  const [groupInput, setGroupInput] = createSignal('');
  const [routeInput, setRouteInput] = createSignal('');

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

  const handleAddGroup = () => {
    const name = groupInput().trim();
    if (name && !setupStore.enterpriseAccessGroups.includes(name)) {
      setupStore.addAccessGroup(name);
      setGroupInput('');
    }
  };

  const handleAddRoute = () => {
    const name = routeInput().trim();
    if (name && !setupStore.dynamicRoutes.includes(name)) {
      setupStore.addDynamicRoute(name);
      setRouteInput('');
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
              <span class="email-tag email-tag--accent">
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

      {/* Regular Users (Optional) — hidden in SaaS mode and enterprise mode.
          REQ-ENTERPRISE-008 AC7: enterprise users are provisioned via Cloudflare
          Access (JIT on first sign-in), not entered by hand, so setup configures
          only admins + the optional Access group. No-op when enterpriseMode unset. */}
      <Show when={!setupStore.saasMode && !setupStore.enterpriseMode}>
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
      </Show>

      {/* Enterprise Access Groups (Optional) — chip list, enterprise only */}
      <Show when={setupStore.enterpriseMode}>
        <div class="setup-field">
          <label class="setup-field-label">Cloudflare Access Groups (optional)</label>
          <p class="setup-field-description">
            Restrict Codeflare to members of one or more Cloudflare Access groups. A user in any of them may sign in; leave blank to admit anyone your Access policy lets through — new users are provisioned automatically on first sign-in. The matched groups are forwarded to your AI Gateway for per-group routing and limits.
          </p>
          <div class="email-input-row">
            <Input
              value={groupInput()}
              onInput={(value) => setGroupInput(value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddGroup(); } }}
              placeholder="e.g. codeflare_developers"
            />
            <Button onClick={handleAddGroup} variant="secondary" size="sm">Add</Button>
          </div>
          <div class="email-tags">
            <For each={setupStore.enterpriseAccessGroups}>
              {(name) => (
                <span class="email-tag email-tag--accent">
                  {name}
                  <button
                    type="button"
                    class="email-tag-remove"
                    onClick={() => setupStore.removeAccessGroup(name)}
                  >
                    x
                  </button>
                </span>
              )}
            </For>
          </div>
        </div>

        {/* Feature C: Dynamic-route catalog (chip list) */}
        <div class="setup-field">
          <label class="setup-field-label">Dynamic Routes</label>
          <p class="setup-field-description">
            Names of the gateway dynamic routes your agents may select (the slash-free handle, e.g. "development"). At least one is required; the first you add becomes the default an agent uses when it does not name a route.
          </p>
          <div class="email-input-row">
            <Input
              value={routeInput()}
              onInput={(value) => setRouteInput(value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddRoute(); } }}
              placeholder="e.g. development"
            />
            <Button onClick={handleAddRoute} variant="secondary" size="sm">Add</Button>
          </div>
          <div class="email-tags">
            <For each={setupStore.dynamicRoutes}>
              {(name) => (
                <span class="email-tag email-tag--accent">
                  {name}
                  <button
                    type="button"
                    class="email-tag-remove"
                    onClick={() => setupStore.removeDynamicRoute(name)}
                  >
                    x
                  </button>
                </span>
              )}
            </For>
          </div>
        </div>

        {/* Feature C: optional default route + reasoning level */}
        <Show when={setupStore.dynamicRoutes.length > 0}>
          <div class="setup-field">
            <label class="setup-field-label">Default Route</label>
            <p class="setup-field-description">
              The route used when an agent does not name one, and its reasoning level (applied inside the container).
            </p>
            <div class="route-default-row">
              <select
                class="route-select"
                value={setupStore.defaultRouteName}
                onChange={(e) => setupStore.setDefaultRouteName(e.currentTarget.value)}
              >
                <For each={setupStore.dynamicRoutes}>
                  {(name) => <option value={name}>{name}</option>}
                </For>
              </select>
              <select
                class="route-select"
                value={setupStore.defaultRouteReasoning}
                disabled={!setupStore.defaultRouteName}
                onChange={(e) => setupStore.setDefaultRouteReasoning(e.currentTarget.value as 'off' | 'low' | 'medium' | 'high')}
              >
                <option value="off">reasoning: off</option>
                <option value="low">reasoning: low</option>
                <option value="medium">reasoning: medium</option>
                <option value="high">reasoning: high</option>
              </select>
            </div>
          </div>
        </Show>
      </Show>

      {/* Navigation */}
      <div class="setup-actions">
        <Button onClick={() => setupStore.prevStep()} variant="ghost">
          Back
        </Button>
        <Button
          onClick={() => setupStore.nextStep()}
          disabled={
            !setupStore.customDomain ||
            setupStore.adminUsers.length === 0 ||
            (setupStore.enterpriseMode && setupStore.dynamicRoutes.length === 0)
          }
        >
          Continue
        </Button>
      </div>

    </div>
  );
};

export default ConfigureStep;
