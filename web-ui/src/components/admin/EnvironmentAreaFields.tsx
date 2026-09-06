/* v8 ignore start -- user-validated administration UI */
import { For, Match, Switch, type Component } from 'solid-js';
import type { AdministrationMode, ConfigurationSection } from '../../types';
import { ianaTimezoneOptions } from '../../lib/iana-timezones';
import AiRoutingFields from './AiRoutingFields';

interface Props {
  section: ConfigurationSection;
  mode: AdministrationMode;
  current: unknown;
  onReadyChange?: (ready: boolean) => void;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function list(value: unknown): string[] { return Array.isArray(value) ? value.map(String) : []; }
function lines(value: unknown): string { return list(value).join('\n'); }

const EnvironmentAreaFields: Component<Props> = (props) => {
  const current = () => record(props.current);
  const field = (name: string, label: string, type = 'text', value: unknown = current()[name]) => (
    <label class="admin-form-field"><span>{label}</span><input name={name} type={type} value={value === null || value === undefined ? '' : String(value)} /></label>
  );
  const toggle = (name: string, label: string, checked = current()[name] === true) => (
    <label class="admin-toggle-field"><input name={name} type="checkbox" checked={checked} /><span>{label}</span></label>
  );
  const textarea = (name: string, label: string, value: string) => (
    <label class="admin-form-field admin-form-wide"><span>{label}</span><textarea name={name} rows="4">{value}</textarea></label>
  );

  return <div class="admin-form-grid"><Switch>
    <Match when={props.section === 'access'}>
      {textarea('adminUsers', 'Administrator emails, one per line', lines(current().adminUsers))}
      {props.mode === 'enterprise'
        ? <>{textarea('userAccessGroups', 'User Access groups, one per line', lines(current().userAccessGroups))}{textarea('adminAccessGroups', 'Administrator Access groups, one per line', lines(current().adminAccessGroups))}</>
        : textarea('allowedUsers', 'Allowed user emails, one per line', lines(current().allowedUsers))}
    </Match>
    <Match when={props.section === 'domain'}>{field('customDomain', 'Custom domain')}</Match>
    <Match when={props.section === 'aiRouting'}><AiRoutingFields current={props.current} onReadyChange={props.onReadyChange} /></Match>
    <Match when={props.section === 'codingAgents'}>
      <div class="admin-form-wide"><span class="admin-field-label">Active agents</span><div class="admin-checkbox-list"><For each={list(current().configurableAgents)}>{(agent) => <label class="admin-toggle-field"><input type="checkbox" name="activeAgents" value={agent} checked={list(current().activeAgents).includes(agent)} /><span>{agent}</span></label>}</For></div></div>
    </Match>
    <Match when={props.section === 'browserRendering'}>{field('accountId', 'Browser Rendering account ID')}{field('replacementToken', 'Replacement API token', 'password', '')}</Match>
    <Match when={props.section === 'securityEgress'}>{toggle('strictGatewayEgress', 'Route all other egress through strict Gateway')}</Match>
    <Match when={props.section === 'dataGovernance'}>{toggle('governedMode', 'Enable governed storage encryption')}{toggle('viewOnlyStorage', 'Disable storage downloads')}</Match>
    <Match when={props.section === 'managedEnvironment'}>
      {toggle('enabled', 'Enable managed environment', current().enabled === true)}{field('repository', 'Curation repository')}{field('personalAccessToken', 'Replacement personal access token', 'password', '')}{field('publicKey', 'Ed25519 public key (hex)', 'text', '')}{toggle('immutableResources', 'Keep managed resources immutable')}{toggle('disableUserCreatedResources', 'Disable user-created resources')}
    </Match>
    <Match when={props.section === 'github'}>
      <label class="admin-form-field"><span>Provider</span><select name="providerType" value={text(current().providerType) || 'app'}><option value="app">GitHub App</option><option value="oauth">OAuth App</option></select></label>
      {field('appClientId', 'GitHub App client ID')}{field('appReplacementSecret', 'Replacement App secret', 'password', '')}{field('oauthClientId', 'OAuth client ID')}{field('oauthReplacementSecret', 'Replacement OAuth secret', 'password', '')}
    </Match>
    <Match when={props.section === 'cloudflareConnection'}>{field('clientId', 'Cloudflare OAuth client ID')}{field('replacementSecret', 'Replacement client secret', 'password', '')}</Match>
    <Match when={props.section === 'usageReports'}>
      {toggle('enabled', 'Enable monthly reports', current().enabled === true)}{textarea('recipients', 'Recipients, one email per line', lines(current().recipients))}{field('day', 'Local delivery day (1–31)', 'number', current().day ?? 1)}{field('hour', 'Local delivery hour (0–23)', 'number', current().hour ?? 9)}
      <label class="admin-form-field"><span>IANA timezone</span><select name="timezone" value={text(current().timezone) || 'UTC'}><For each={ianaTimezoneOptions(text(current().timezone) || 'UTC')}>{(timezone) => <option value={timezone}>{timezone}</option>}</For></select></label>
    </Match>
  </Switch></div>;
};

function split(value: FormDataEntryValue | null): string[] {
  return String(value ?? '').split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}
function value(data: FormData, key: string): string { return String(data.get(key) ?? '').trim(); }
function checked(data: FormData, key: string): boolean { return data.has(key); }
function parsed(data: FormData, key: string, fallback: unknown): unknown {
  const raw = value(data, key);
  return raw ? JSON.parse(raw) : fallback;
}
function routeContextWindows(data: FormData): Record<string, number> {
  const routes = data.getAll('routeContextRoute').map(String);
  const windows = data.getAll('routeContextWindow').map((item) => Number(item));
  return Object.fromEntries(routes.map((route, index) => [route, windows[index]]));
}

export function environmentValues(section: ConfigurationSection, mode: AdministrationMode, data: FormData): unknown {
  switch (section) {
    case 'access': return mode === 'enterprise'
      ? { adminUsers: split(data.get('adminUsers')), userAccessGroups: split(data.get('userAccessGroups')), adminAccessGroups: split(data.get('adminAccessGroups')) }
      : { adminUsers: split(data.get('adminUsers')), allowedUsers: split(data.get('allowedUsers')) };
    case 'domain': return { customDomain: value(data, 'customDomain') };
    case 'aiRouting': return {
      gatewayUrl: value(data, 'gatewayUrl'),
      replacementToken: value(data, 'replacementToken'),
      dynamicRoutes: data.getAll('dynamicRoutes').map(String),
      defaultRoute: { route: value(data, 'defaultRoute'), reasoning: value(data, 'reasoning') },
      routeContextWindows: routeContextWindows(data),
      reasoningConfiguration: parsed(data, 'reasoningConfiguration', { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {} }),
      groupRouting: parsed(data, 'groupRouting', []),
      ...(data.has('fallbackRouting') && { fallbackRouting: parsed(data, 'fallbackRouting', { enabled: false }) }),
      ...(data.has('routeChecks') && { routeChecks: parsed(data, 'routeChecks', {}) }),
    };
    case 'codingAgents': return { activeAgents: data.getAll('activeAgents').map(String) };
    case 'browserRendering': return { accountId: value(data, 'accountId'), replacementToken: value(data, 'replacementToken') };
    case 'securityEgress': return { strictGatewayEgress: checked(data, 'strictGatewayEgress') };
    case 'dataGovernance': return { governedMode: checked(data, 'governedMode'), viewOnlyStorage: checked(data, 'viewOnlyStorage') };
    case 'managedEnvironment': return checked(data, 'enabled') ? { enabled: true, repository: value(data, 'repository'), personalAccessToken: value(data, 'personalAccessToken'), publicKey: value(data, 'publicKey'), immutableResources: checked(data, 'immutableResources'), disableUserCreatedResources: checked(data, 'disableUserCreatedResources') } : { enabled: false };
    case 'github': return { providerType: value(data, 'providerType'), appClientId: value(data, 'appClientId'), appReplacementSecret: value(data, 'appReplacementSecret'), oauthClientId: value(data, 'oauthClientId'), oauthReplacementSecret: value(data, 'oauthReplacementSecret') };
    case 'cloudflareConnection': return { clientId: value(data, 'clientId'), replacementSecret: value(data, 'replacementSecret') };
    case 'usageReports': return checked(data, 'enabled') ? { enabled: true, recipients: split(data.get('recipients')), day: Number(value(data, 'day')), hour: Number(value(data, 'hour')), timezone: value(data, 'timezone') } : { enabled: false };
  }
}

export default EnvironmentAreaFields;
/* v8 ignore stop */
