import { Component, For, Show, onMount } from 'solid-js';
import { setupStore } from '../../stores/setup';
import Button from '../ui/Button';
import Input from '../ui/Input';
import ChipListField from '../ui/ChipListField';
import Select from '../ui/Select';
import PerGroupRoutingCard from './PerGroupRoutingCard';
import GitHubProviderChooser from './GitHubProviderChooser';
import '../../styles/configure-step.css';

const REASONING_OPTIONS = [
  { value: 'off', label: 'reasoning: off' },
  { value: 'low', label: 'reasoning: low' },
  { value: 'medium', label: 'reasoning: medium' },
  { value: 'high', label: 'reasoning: high' },
];

const ConfigureStep: Component = () => {
  // Pre-fill from existing config when re-configuring
  onMount(async () => {
    try {
      await setupStore.loadExistingConfig();
    } catch {
      // Best-effort pre-fill
    }
  });

  // onAdd callbacks return true when the value is accepted (ChipListField then clears
  // its input), preserving the original "don't clear on invalid" behavior.
  const addAdminEmail = (raw: string): boolean => {
    const email = raw.trim().toLowerCase();
    if (email && /.+@.+\..+/.test(email) && !setupStore.adminUsers.includes(email)) {
      setupStore.addAdminUser(email);
      return true;
    }
    return false;
  };

  const addRegularEmail = (raw: string): boolean => {
    const email = raw.trim().toLowerCase();
    if (email && /.+@.+\..+/.test(email) && !setupStore.allowedUsers.includes(email)) {
      setupStore.addAllowedUser(email);
      return true;
    }
    return false;
  };

  const addGroup = (raw: string): boolean => {
    const name = raw.trim();
    if (name && !setupStore.enterpriseAccessGroups.includes(name)) {
      setupStore.addAccessGroup(name);
      return true;
    }
    return false;
  };

  const addAdminGroup = (raw: string): boolean => {
    const name = raw.trim();
    if (name && !setupStore.adminAccessGroups.includes(name)) {
      setupStore.addAdminAccessGroup(name);
      return true;
    }
    return false;
  };

  const addRoute = (raw: string): boolean => {
    const name = raw.trim();
    if (name && !setupStore.dynamicRoutes.includes(name)) {
      setupStore.addDynamicRoute(name);
      return true;
    }
    return false;
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
      <ChipListField
        label="Admin Users"
        description="Full access including user management"
        items={setupStore.adminUsers}
        placeholder="admin@example.com"
        accent
        onAdd={addAdminEmail}
        onRemove={(email) => setupStore.removeAdminUser(email)}
      />

      {/* Regular Users (Optional) — hidden in SaaS mode and enterprise mode.
          REQ-ENTERPRISE-008 AC7: enterprise users are provisioned via Cloudflare
          Access (JIT on first sign-in), not entered by hand, so setup configures
          only admins + the optional Access group. No-op when enterpriseMode unset. */}
      <Show when={!setupStore.saasMode && !setupStore.enterpriseMode}>
        <ChipListField
          label="Regular Users"
          description="Can use Codeflare but cannot manage users"
          items={setupStore.allowedUsers}
          placeholder="user@example.com"
          onAdd={addRegularEmail}
          onRemove={(email) => setupStore.removeAllowedUser(email)}
        />
      </Show>

      {/* Enterprise Access Groups (Optional) — chip list, enterprise only */}
      <Show when={setupStore.enterpriseMode}>
        <ChipListField
          label="Cloudflare Access Groups (optional)"
          description="Restrict Codeflare to members of one or more Cloudflare Access groups. A user in any of them may sign in; leave blank to admit anyone your Access policy lets through — new users are provisioned automatically on first sign-in. The matched groups are forwarded to your AI Gateway for per-group routing and limits."
          items={setupStore.enterpriseAccessGroups}
          placeholder="e.g. codeflare_developers"
          accent
          onAdd={addGroup}
          onRemove={(name) => setupStore.removeAccessGroup(name)}
        />

        {/* REQ-ENTERPRISE-014: admin Access groups — members get admin (= Setup)
            access, parallel to the email-based "Admin Users" list above. These
            groups are NOT used for per-group routing (only the user-access groups
            below appear there); they only widen who can administer the instance. */}
        <ChipListField
          label="Cloudflare Admin Access Groups (optional)"
          description="Grant admin access (including Setup and user management) to members of one or more Cloudflare Access groups, in addition to the Admin Users listed above. Leave blank to keep admin access limited to those named admins. Not used for per-group model routing."
          items={setupStore.adminAccessGroups}
          placeholder="e.g. codeflare_admins"
          accent
          onAdd={addAdminGroup}
          onRemove={(name) => setupStore.removeAdminAccessGroup(name)}
        />

        {/* Feature C: Dynamic-route catalog (chip list) */}
        <ChipListField
          label="Dynamic Routes"
          description={'Names of the gateway dynamic routes your agents may select (the slash-free handle, e.g. "development"). At least one is required; the first you add becomes the default an agent uses when it does not name a route.'}
          items={setupStore.dynamicRoutes}
          placeholder="e.g. development"
          accent
          onAdd={addRoute}
          onRemove={(name) => setupStore.removeDynamicRoute(name)}
        />

        {/* Feature C: optional default route + reasoning level. Shown only when no
            Access groups exist — once groups are added, routing is configured
            per-group below (the stored global default still serves as the
            fallback for users who match no configured group). */}
        <Show when={setupStore.dynamicRoutes.length > 0 && setupStore.enterpriseAccessGroups.length === 0}>
          <div class="setup-field">
            <label class="setup-field-label">Default Route</label>
            <p class="setup-field-description">
              The route used when an agent does not name one, and its reasoning level (applied inside the container).
            </p>
            <div class="route-default-row">
              <Select
                value={setupStore.defaultRouteName}
                options={setupStore.dynamicRoutes.map((name) => ({ value: name, label: name }))}
                onChange={(v) => setupStore.setDefaultRouteName(v)}
              />
              <Select
                value={setupStore.defaultRouteReasoning}
                options={REASONING_OPTIONS}
                disabled={!setupStore.defaultRouteName}
                onChange={(v) => setupStore.setDefaultRouteReasoning(v as 'off' | 'low' | 'medium' | 'high')}
              />
            </div>
          </div>
        </Show>

        {/* REQ-ENTERPRISE-013: per-group routing — one card per Access group, shown once
            at least one group and one route exist. */}
        <Show when={setupStore.enterpriseAccessGroups.length > 0 && setupStore.dynamicRoutes.length > 0}>
          <div class="setup-field">
            <label class="setup-field-label">Per-Group Routing</label>
            <p class="setup-field-description">
              For each Access group, choose which routes its members may use and the default route + reasoning. A user in several groups uses the first matching group in the list above. Use "Apply to all groups" to copy one group's setup to the rest.
            </p>
            <For each={setupStore.enterpriseAccessGroups}>
              {(group) => (
                <PerGroupRoutingCard
                  groupName={group}
                  availableRoutes={setupStore.dynamicRoutes}
                  selectedRoutes={setupStore.groupRouting[group]?.routes ?? []}
                  defaultRoute={setupStore.groupRouting[group]?.defaultRoute ?? ''}
                  reasoning={setupStore.groupRouting[group]?.reasoning ?? 'off'}
                  onToggleRoute={(route) => setupStore.toggleGroupRoute(group, route)}
                  onDefaultChange={(route) => setupStore.setGroupDefaultRoute(group, route)}
                  onReasoningChange={(level) => setupStore.setGroupReasoning(group, level)}
                  onApplyToAll={() => setupStore.applyGroupRoutingToAll(group)}
                  showApplyToAll={setupStore.enterpriseAccessGroups.length > 1}
                />
              )}
            </For>
          </div>
        </Show>

        {/* REQ-BROWSER-007: admin-global Cloudflare Browser Rendering token. In
            enterprise the per-user deploy-keys accordion is hidden, so the browser-run
            feature's Cloudflare token is configured once here for every user. */}
        <div class="setup-field">
          <label class="setup-field-label">Cloudflare Browser Rendering Token (optional)</label>
          <p class="setup-field-description">
            Enables the in-session browser tools for everyone. Use a Cloudflare API token scoped to Browser Rendering — Edit only; it is stored encrypted. Leave blank to keep the browser tools off.
            <Show when={setupStore.cloudflareBrowserTokenSet}> A token is already saved — leave blank to keep it, or enter a new one to replace it.</Show>
          </p>
          <Input
            type="password"
            value={setupStore.cloudflareBrowserToken}
            onInput={(value) => setupStore.setCloudflareBrowserToken(value)}
            placeholder={setupStore.cloudflareBrowserTokenSet ? 'Saved — enter a new token to replace' : 'Cloudflare API token...'}
          />
        </div>

        <div class="setup-field">
          <label class="setup-field-label">Cloudflare Account ID (for Browser Rendering)</label>
          <p class="setup-field-description">
            The account that owns Browser Rendering — required for the token above to work.
          </p>
          <Input
            value={setupStore.cloudflareBrowserAccountId}
            onInput={(value) => setupStore.setCloudflareBrowserAccountId(value)}
            placeholder="32-character account ID"
          />
        </div>

        {/* REQ-GITHUB-008: enterprise GitHub provider config (GitHub App vs OAuth App). */}
        <GitHubProviderChooser
          providerType={setupStore.githubProviderType}
          appClientId={setupStore.githubAppClientId}
          appClientSecret={setupStore.githubAppClientSecret}
          appClientSecretSet={setupStore.githubAppClientSecretSet}
          oauthClientId={setupStore.githubOauthClientId}
          oauthClientSecret={setupStore.githubOauthClientSecret}
          oauthClientSecretSet={setupStore.githubOauthClientSecretSet}
          onProviderTypeChange={(t) => setupStore.setGithubProviderType(t)}
          onAppClientIdChange={(v) => setupStore.setGithubAppClientId(v)}
          onAppClientSecretChange={(v) => setupStore.setGithubAppClientSecret(v)}
          onOauthClientIdChange={(v) => setupStore.setGithubOauthClientId(v)}
          onOauthClientSecretChange={(v) => setupStore.setGithubOauthClientSecret(v)}
        />
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
