import { For, Show, createMemo, createUniqueId, type Component } from 'solid-js';
import type { ConfigurationPreview } from '../../api/client';
import { operatorTaskLabel } from './administration-presentation';
import { profileDisplayName } from './pi-profile-presentation';
import './AiRoutingReview.css';

type Changes = ConfigurationPreview['changes'];
interface SummaryProps {
  values: unknown;
  current: unknown;
  changes: Changes;
  saved?: boolean;
}
interface ReviewProps extends Omit<SummaryProps, 'changes' | 'saved'> {
  preview: ConfigurationPreview;
  confirmedWarnings: readonly string[];
  busy?: boolean;
  onWarningChange: (code: string, checked: boolean) => void;
  onBack: () => void;
  onConfirm: () => void;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function list(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function revisions(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(record) : []; }
function sameRevision(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return typeof left.id === 'string' && typeof left.revision === 'number' && typeof left.hash === 'string'
    && left.id === right.id && left.revision === right.revision && left.hash === right.hash;
}
function reasoningLabel(value: unknown): string {
  const labels: Record<string, string> = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum' };
  return Object.prototype.hasOwnProperty.call(labels, text(value)) ? labels[text(value)] : 'Not configured';
}

// Render only the summary's allowlisted fields, never the values or change objects.
// Redact known credential strings too, in case a server warning echoes one.
function redactor(values: unknown, current: unknown, changes: Changes): (value: string) => string {
  const secrets = [record(values).replacementToken, record(current).replacementToken,
    ...changes.filter((change) => change.secret || change.field === 'replacementToken').flatMap((change) => [change.before, change.after]),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort((left, right) => right.length - left.length);
  return (value) => secrets.reduce((safe, secret) => safe.split(secret).join('[redacted]'), value);
}
function gatewayAddress(value: unknown): string {
  if (!text(value)) return 'Not configured';
  try {
    const url = new URL(text(value));
    if (!['https:', 'http:'].includes(url.protocol)) return 'Gateway URL unavailable';
    // Credentials, queries and fragments are not part of a gateway address.
    return `${url.origin}${url.pathname}`;
  } catch { return 'Gateway URL unavailable'; }
}

/** REQ-ENTERPRISE-041: the same safe, grouped configuration is used for review and successful Save. */
export const AiRoutingSummary: Component<SummaryProps> = (props) => {
  const id = createUniqueId();
  const data = createMemo(() => ({ ...record(props.current), ...record(props.values) }));
  const safe = createMemo(() => redactor(props.values, props.current, props.changes));
  const configuration = () => record(data().reasoningConfiguration);
  const assignments = () => record(configuration().routeAssignments);
  const profiles = () => revisions(configuration().customProfileRevisions);
  const savedProfiles = () => revisions(record(record(props.current).reasoningConfiguration).customProfileRevisions);
  const routes = () => list(data().dynamicRoutes);
  const groups = () => revisions(data().groupRouting);
  const explicitFallback = () => {
    const directChange = props.changes.find((change) => change.field === 'fallbackRouting');
    const reasoningChange = props.changes.find((change) => change.field === 'reasoningConfiguration');
    const submitted = record(props.values);
    const current = record(props.current);
    return directChange?.after ?? record(reasoningChange?.after).fallbackRouting
      ?? submitted.fallbackRouting ?? record(submitted.reasoningConfiguration).fallbackRouting
      ?? current.fallbackRouting ?? record(current.reasoningConfiguration).fallbackRouting;
  };
  const fallback = () => record(explicitFallback() ?? data().defaultRoute);
  const fallbackEnabled = () => explicitFallback() !== undefined
    ? fallback().enabled === true : fallback().enabled !== false && Boolean(text(fallback().route));
  const fallbackRoutes = () => explicitFallback() !== undefined || Array.isArray(fallback().routes) ? list(fallback().routes) : routes();
  const fallbackDefault = () => explicitFallback() !== undefined ? fallback().defaultRoute : fallback().route;
  const profileFor = (route: string) => record(record(assignments()[route]).activeProfile);
  const customFor = (ref: Record<string, unknown>) => profiles().find((profile) => sameRevision(profile, ref));
  const nameFor = (ref: Record<string, unknown>) => {
    if (!text(ref.id)) return 'No profile assigned';
    const custom = customFor(ref);
    const label = profileDisplayName({ id: text(ref.id), name: text(custom?.name) });
    return safe()(label === ref.id ? 'Profile name unavailable' : label);
  };
  const pending = (profile: Record<string, unknown>) => !props.saved && !savedProfiles().some((saved) => sameRevision(saved, profile));
  const unassigned = () => profiles().filter((profile) => pending(profile) && !routes().some((route) => sameRevision(profileFor(route), profile)));
  const contextWindow = (route: string) => {
    const tokens = record(data().routeContextWindows)[route];
    return typeof tokens === 'number' && Number.isFinite(tokens) ? `${tokens.toLocaleString('en-US')} tokens` : 'Not configured';
  };
  const replacingToken = () => props.changes.find((change) => change.field === 'replacementToken')?.secret?.willReplace
    ?? Boolean(text(record(props.values).replacementToken));
  const tokenSummary = () => props.saved
    ? (replacingToken() ? 'Saved token replaced' : 'Saved token preserved')
    : (replacingToken() ? 'Replace saved token' : 'Preserve saved token');
  const routeList = (items: string[]) => <Show when={items.length} fallback={<span>No routes allowed</span>}>
    <ul class="ai-routing-review-route-list" aria-label="Allowed routes"><For each={items}>{(route) => <li>{safe()(route)}</li>}</For></ul>
  </Show>;

  return <div class="ai-routing-review-summary">
    <section class="ai-routing-review-section" aria-labelledby={`${id}-connection`}>
      <h3 id={`${id}-connection`}>Connection</h3>
      <dl class="ai-routing-review-values">
        <div><dt>Gateway URL</dt><dd>{safe()(gatewayAddress(data().gatewayUrl))}</dd></div>
        <div><dt>API token</dt><dd>{tokenSummary()}</dd></div>
      </dl>
    </section>
    <section class="ai-routing-review-section" aria-labelledby={`${id}-profiles`}>
      <h3 id={`${id}-profiles`}>Route profiles</h3>
      <Show when={routes().length} fallback={<p>No routes configured</p>}>
        <table class="ai-routing-review-routes" aria-labelledby={`${id}-profiles`}>
          <thead><tr><th scope="col">Route</th><th scope="col">Profile</th><th scope="col">Context window</th></tr></thead>
          <tbody><For each={routes()}>{(route) => <tr>
            <th scope="row">{safe()(route)}</th>
            <td><span class="ai-routing-review-mobile-label" aria-hidden="true">Profile</span><span>{nameFor(profileFor(route))}<Show when={customFor(profileFor(route)) && pending(customFor(profileFor(route))!)}><small class="ai-routing-review-pending">Pending save</small></Show></span></td>
            <td><span class="ai-routing-review-mobile-label" aria-hidden="true">Context window</span>{contextWindow(route)}</td>
          </tr>}</For></tbody>
        </table>
      </Show>
      <Show when={unassigned().length}>
        <section class="ai-routing-review-unassigned" aria-labelledby={`${id}-unassigned`}>
          <h4 id={`${id}-unassigned`}>Other profiles pending save</h4>
          <ul><For each={unassigned()}>{(profile) => <li><strong>{safe()(text(profile.name) || 'Unnamed custom profile')}</strong><span>Unassigned</span></li>}</For></ul>
        </section>
      </Show>
    </section>
    <section class="ai-routing-review-section" aria-labelledby={`${id}-groups`}>
      <h3 id={`${id}-groups`}>Group access</h3>
      <Show when={groups().length} fallback={<p>No group policies</p>}>
        <div class="ai-routing-review-groups"><For each={groups()}>{(group) => <article aria-label={safe()(text(group.accessGroup))}>
          <h4>{safe()(text(group.accessGroup))}</h4>
          <dl class="ai-routing-review-values">
            <div><dt>Allowed routes</dt><dd>{routeList(list(group.routes))}</dd></div>
            <div><dt>Default route</dt><dd>{safe()(text(group.defaultRoute) || 'Not configured')}</dd></div>
            <div><dt>Default reasoning</dt><dd>{reasoningLabel(group.reasoning)}</dd></div>
          </dl>
        </article>}</For></div>
      </Show>
    </section>
    <section class="ai-routing-review-section" aria-labelledby={`${id}-fallback`}>
      <h3 id={`${id}-fallback`}>Fallback</h3>
      <Show when={fallbackEnabled()} fallback={<><strong>No fallback access</strong><p>Users without a matching group policy cannot use these routes.</p></>}>
        <p>Applies to users without a matching group policy.</p>
        <dl class="ai-routing-review-values">
          <div><dt>Allowed routes</dt><dd>{routeList(fallbackRoutes())}</dd></div>
          <div><dt>Default route</dt><dd>{safe()(text(fallbackDefault()) || 'Not configured')}</dd></div>
          <div><dt>Default reasoning</dt><dd>{reasoningLabel(fallback().reasoning)}</dd></div>
        </dl>
      </Show>
    </section>
  </div>;
};

/** REQ-ENTERPRISE-041: review-only presentation; EnvironmentAreaDetail owns submitted values and saving. */
const AiRoutingReview: Component<ReviewProps> = (props) => {
  const id = createUniqueId();
  const safe = createMemo(() => redactor(props.values, props.current, props.preview.changes));
  const canConfirm = () => !props.busy && props.preview.changes.length > 0
    && props.preview.warnings.every((warning) => props.confirmedWarnings.includes(warning.code));
  const assignments = () => Object.entries(record(record(record(props.values).reasoningConfiguration).routeAssignments));

  return <div class="ai-routing-review">
    <Show when={props.preview.warnings.length}>
      <section class="ai-routing-review-warnings" aria-labelledby={`${id}-warnings`}>
        <h3 id={`${id}-warnings`}>Warnings to acknowledge</h3>
        <p>Review each warning before confirming this save.</p>
        <For each={props.preview.warnings}>{(warning) => <label class="ai-routing-review-warning">
          <input type="checkbox" checked={props.confirmedWarnings.includes(warning.code)} disabled={props.busy}
            onChange={(event) => props.onWarningChange(warning.code, event.currentTarget.checked)} />
          <span><strong>Confirm warning</strong><span>{safe()(warning.message)}</span></span>
        </label>}</For>
      </section>
    </Show>
    <Show when={props.preview.changes.length > 0} fallback={<div class="admin-state-panel"><h3>No changes detected</h3><p>Return to edit before saving.</p></div>}>
      <AiRoutingSummary values={props.values} current={props.current} changes={props.preview.changes} />
      <details class="admin-technical-details ai-routing-review-technical">
        <summary>Technical details</summary>
        <h3>Execution plan</h3>
        <ol class="admin-task-plan"><For each={props.preview.tasks}>{(task) => <li>{safe()(operatorTaskLabel(task.id))}</li>}</For></ol>
        <dl>
          <div><dt>Base revision</dt><dd>{props.preview.baseRevision}</dd></div>
          <div><dt>Task IDs</dt><dd class="admin-mono">{safe()(props.preview.tasks.map((task) => task.id).join(', ') || 'None')}</dd></div>
          <div><dt>Excluded setup work</dt><dd class="admin-mono">{safe()(props.preview.exclusions.join(', ') || 'None')}</dd></div>
        </dl>
        <Show when={assignments().length}>
          <h3>Profile references</h3>
          <dl><For each={assignments()}>{([route, assignment]) => {
            const ref = () => record(record(assignment).activeProfile);
            return <div><dt>{safe()(route)}</dt><dd class="admin-mono">{safe()(text(ref().id) || 'Unassigned')} · Revision {typeof ref().revision === 'number' ? String(ref().revision) : 'unknown'}<Show when={text(ref().hash)}><span class="ai-routing-review-hash">{safe()(text(ref().hash))}</span></Show></dd></div>;
          }}</For></dl>
        </Show>
      </details>
    </Show>
    <div class="admin-form-actions">
      <button type="button" class="admin-secondary-button" disabled={props.busy} onClick={props.onBack}>Back to edit</button>
      <Show when={props.preview.changes.length > 0}><button type="button" class="admin-primary-button" disabled={!canConfirm()} onClick={() => { if (canConfirm()) props.onConfirm(); }}>{props.busy ? 'Saving…' : 'Confirm Save'}</button></Show>
    </div>
  </div>;
};

export default AiRoutingReview;
