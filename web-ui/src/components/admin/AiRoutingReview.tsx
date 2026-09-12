import { For, Show, createMemo, createUniqueId, type Component } from 'solid-js';
import type { ConfigurationPreview } from '../../api/client';
import { operatorTaskLabel } from './administration-presentation';
import { profileDisplayName } from './pi-profile-presentation';
import { canonicalJson, getBuiltInProfile } from '../../../../src/lib/reasoning-profiles';
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

// Raw submitted values are used for redaction only. The server owns the review diff.
function reviewStates(current: unknown, changes: Changes) {
  const before = { ...record(current) };
  const after = { ...before };
  for (const change of changes) if (!change.secret) {
    if ('before' in change) before[change.field] = change.before;
    after[change.field] = change.after;
  }
  return { before, after };
}
const equal = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const assignmentsFor = (state: Record<string, unknown>) => record(record(state.reasoningConfiguration).routeAssignments);
function changedRoutes(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const oldAssignments = assignmentsFor(before); const newAssignments = assignmentsFor(after);
  const oldWindows = record(before.routeContextWindows); const newWindows = record(after.routeContextWindows);
  const oldActive = list(before.dynamicRoutes); const newActive = list(after.dynamicRoutes);
  return [...new Set([...Object.keys(newAssignments), ...Object.keys(oldAssignments), ...Object.keys(newWindows), ...Object.keys(oldWindows), ...newActive, ...oldActive])]
    .filter((route) => !equal(oldAssignments[route], newAssignments[route]) || !equal(oldWindows[route], newWindows[route]) || oldActive.includes(route) !== newActive.includes(route));
}
const ValueChange: Component<{ before?: string; after: string }> = (props) => <>
  <Show when={props.before !== undefined && props.before !== props.after}><span aria-label="Previous value">{props.before}</span><span aria-hidden="true"> → </span></Show>
  <span>{props.after}</span>
</>;

/** REQ-ENTERPRISE-041/069: Review and successful Save display the same authoritative delta. */
export const AiRoutingSummary: Component<SummaryProps> = (props) => {
  const id = createUniqueId();
  const states = createMemo(() => reviewStates(props.current, props.changes));
  const before = () => states().before;
  const data = () => states().after;
  const changed = (field: string) => props.changes.some((change) => change.field === field && (!change.secret || change.secret.willReplace));
  const safe = createMemo(() => redactor(props.values, props.current, props.changes));
  const configuration = () => record(data().reasoningConfiguration);
  const assignments = () => assignmentsFor(data());
  const profiles = () => revisions(configuration().customProfileRevisions);
  const savedProfiles = () => revisions(record(before().reasoningConfiguration).customProfileRevisions);
  const routes = () => changedRoutes(before(), data());
  const nativeTargets = () => revisions(data().nativeTargets);
  const groups = () => revisions(data().groupRouting);
  const explicitFallback = () => props.changes.find((change) => change.field === 'fallbackRouting')?.after
    ?? record(props.changes.find((change) => change.field === 'reasoningConfiguration')?.after).fallbackRouting
    ?? data().fallbackRouting ?? configuration().fallbackRouting;
  const fallback = () => record(explicitFallback() ?? data().defaultRoute);
  const fallbackEnabled = () => explicitFallback() !== undefined
    ? fallback().enabled === true : fallback().enabled !== false && Boolean(text(fallback().route));
  const fallbackRoutes = () => explicitFallback() !== undefined || Array.isArray(fallback().routes) ? list(fallback().routes) : list(data().dynamicRoutes);
  const fallbackDefault = () => explicitFallback() !== undefined ? fallback().defaultRoute : fallback().route;
  const fallbackChanged = () => changed('fallbackRouting') || changed('defaultRoute')
    || !equal(record(before().reasoningConfiguration).fallbackRouting, configuration().fallbackRouting);
  const profileFor = (route: string, state = data()) => record(record(assignmentsFor(state)[route]).activeProfile);
  const customFor = (ref: Record<string, unknown>) => profiles().find((profile) => sameRevision(profile, ref));
  const providerDefault = (route: string) => {
    const ref = profileFor(route);
    const profile = customFor(ref) ?? record(getBuiltInProfile(text(ref.id)));
    return sameRevision(profile, ref) && profile.reasoningMode === 'provider-default';
  };
  const policyReasoning = (route: unknown, level: unknown) => providerDefault(text(route)) ? 'Provider default' : reasoningLabel(level);
  const nameFor = (ref: Record<string, unknown>) => {
    if (!text(ref.id)) return 'No profile assigned';
    const custom = customFor(ref) ?? savedProfiles().find((profile) => sameRevision(profile, ref));
    const label = profileDisplayName({ id: text(ref.id), name: text(custom?.name) });
    return safe()(label === ref.id ? 'Profile name unavailable' : label);
  };
  const pending = (profile: Record<string, unknown>) => !props.saved && !savedProfiles().some((saved) => sameRevision(saved, profile));
  const unassigned = () => profiles().filter((profile) => !savedProfiles().some((saved) => sameRevision(saved, profile))
    && !Object.keys(assignments()).some((route) => sameRevision(profileFor(route), profile)));
  const contextWindow = (route: string, state = data()) => {
    const tokens = record(state.routeContextWindows)[route];
    return typeof tokens === 'number' && Number.isFinite(tokens) ? `${tokens.toLocaleString('en-US')} tokens` : 'Not configured';
  };
  const routeChange = (route: string) => !assignments()[route] && assignmentsFor(before())[route] ? 'Removed'
    : !assignmentsFor(before())[route] && assignments()[route] ? 'Added' : 'Updated';
  const replacingToken = () => props.changes.find((change) => change.field === 'replacementToken')?.secret?.willReplace
    ?? false;
  const tokenSummary = () => props.saved
    ? (replacingToken() ? 'Saved token replaced' : 'Saved token preserved')
    : (replacingToken() ? 'Replace saved token' : 'Preserve saved token');
  const routeList = (items: string[]) => <Show when={items.length} fallback={<span>No routes allowed</span>}>
    <ul class="ai-routing-review-route-list" aria-label="Allowed routes"><For each={items}>{(route) => <li>{safe()(route)}</li>}</For></ul>
  </Show>;

  return <div class="ai-routing-review-summary">
    <Show when={changed('gatewayUrl') || changed('gatewayId') || changed('replacementToken')}><section class="ai-routing-review-section" aria-labelledby={`${id}-connection`}>
      <h3 id={`${id}-connection`}>Connection</h3>
      <dl class="ai-routing-review-values">
        <Show when={changed('gatewayUrl')}><div><dt>Gateway URL</dt><dd><ValueChange before={safe()(gatewayAddress(before().gatewayUrl))} after={safe()(gatewayAddress(data().gatewayUrl))} /></dd></div></Show>
        <Show when={changed('gatewayId')}><div><dt>Gateway name</dt><dd>{safe()(text(data().gatewayId))}</dd></div></Show>
        <Show when={changed('replacementToken')}><div><dt>API token</dt><dd>{tokenSummary()}</dd></div></Show>
      </dl>
    </section></Show>
    <Show when={routes().length || unassigned().length}><section class="ai-routing-review-section" aria-labelledby={`${id}-profiles`}>
      <h3 id={`${id}-profiles`}>Route profiles</h3>
      <Show when={routes().length} fallback={<p>No routes configured</p>}>
        <table class="ai-routing-review-routes" aria-labelledby={`${id}-profiles`}>
          <thead><tr><th scope="col">Route</th><th scope="col">Profile</th><th scope="col">Context window</th></tr></thead>
          <tbody><For each={routes()}>{(route) => <tr>
            <th scope="row"><div>{safe()(route)}</div><small>{routeChange(route)}</small></th>
            <td><span class="ai-routing-review-mobile-label" aria-hidden="true">Profile</span><span><ValueChange before={nameFor(profileFor(route, before()))} after={nameFor(profileFor(route))} /><Show when={providerDefault(route)}><br /><small>Provider default</small></Show><Show when={customFor(profileFor(route)) && pending(customFor(profileFor(route))!)}><small class="ai-routing-review-pending">Pending save</small></Show></span></td>
            <td><span class="ai-routing-review-mobile-label" aria-hidden="true">Context window</span><span><ValueChange before={contextWindow(route, before())} after={contextWindow(route)} /></span></td>
          </tr>}</For></tbody>
        </table>
      </Show>
      <Show when={unassigned().length}>
        <section class="ai-routing-review-unassigned" aria-labelledby={`${id}-unassigned`}>
          <h4 id={`${id}-unassigned`}>{props.saved ? 'Other saved profiles' : 'Other profiles pending save'}</h4>
          <ul><For each={unassigned()}>{(profile) => <li><strong>{safe()(text(profile.name) || 'Unnamed custom profile')}</strong><span>Unassigned</span></li>}</For></ul>
        </section>
      </Show>
    </section></Show>
    <Show when={changed('nativeTargets')}><section class="ai-routing-review-section" aria-labelledby={`${id}-native`}>
      <h3 id={`${id}-native`}>Native routes</h3>
      <table class="ai-routing-review-routes" aria-labelledby={`${id}-native`}><thead><tr><th scope="col">Target</th><th scope="col">Exact model</th><th scope="col">AWS region</th><th scope="col">Context window</th><th scope="col">State</th></tr></thead>
        <tbody><For each={nativeTargets()}>{(target) => <tr><th scope="row">{safe()(text(target.label) || 'Unnamed target')}</th><td>{safe()(text(target.model))}</td><td>{safe()(text(target.region)) || 'Not applicable'}</td><td>{typeof target.contextWindow === 'number' ? `${target.contextWindow.toLocaleString('en-US')} tokens` : 'Not configured'}</td><td>{target.enabled === true ? 'Enabled' : 'Inactive'}</td></tr>}</For></tbody>
      </table>
    </section></Show>
    <Show when={changed('groupRouting')}><section class="ai-routing-review-section" aria-labelledby={`${id}-groups`}>
      <h3 id={`${id}-groups`}>Group access</h3>
      <Show when={groups().length} fallback={<p>No group policies</p>}>
        <div class="ai-routing-review-groups"><For each={groups()}>{(group) => <article aria-label={safe()(text(group.accessGroup))}>
          <h4>{safe()(text(group.accessGroup))}</h4>
          <dl class="ai-routing-review-values">
            <div><dt>Allowed routes</dt><dd>{routeList(list(group.routes))}</dd></div>
            <div><dt>Default route</dt><dd>{safe()(text(group.defaultRoute) || 'Not configured')}</dd></div>
            <div><dt>Default reasoning</dt><dd>{policyReasoning(group.defaultRoute, group.reasoning)}</dd></div>
          </dl>
        </article>}</For></div>
      </Show>
    </section></Show>
    <Show when={fallbackChanged()}><section class="ai-routing-review-section" aria-labelledby={`${id}-fallback`}>
      <h3 id={`${id}-fallback`}>Fallback</h3>
      <Show when={fallbackEnabled()} fallback={<><strong>No fallback access</strong><p>Users without a matching group policy cannot use these routes.</p></>}>
        <p>Applies to users without a matching group policy.</p>
        <dl class="ai-routing-review-values">
          <div><dt>Allowed routes</dt><dd>{routeList(fallbackRoutes())}</dd></div>
          <div><dt>Default route</dt><dd>{safe()(text(fallbackDefault()) || 'Not configured')}</dd></div>
          <div><dt>Default reasoning</dt><dd>{policyReasoning(fallbackDefault(), fallback().reasoning)}</dd></div>
        </dl>
      </Show>
    </section></Show>
  </div>;
};

/** REQ-ENTERPRISE-041: review-only presentation; EnvironmentAreaDetail owns submitted values and saving. */
const AiRoutingReview: Component<ReviewProps> = (props) => {
  const id = createUniqueId();
  const safe = createMemo(() => redactor(props.values, props.current, props.preview.changes));
  const hasChanges = () => props.preview.changes.some((change) => !change.secret || change.secret.willReplace);
  const canConfirm = () => !props.busy && hasChanges()
    && props.preview.warnings.every((warning) => props.confirmedWarnings.includes(warning.code));
  const assignments = () => {
    const { before, after } = reviewStates(props.current, props.preview.changes);
    return changedRoutes(before, after).map((route) => [route, assignmentsFor(after)[route]] as const);
  };

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
    <Show when={hasChanges()} fallback={<div class="admin-state-panel"><h3>No changes detected</h3><p>Return to edit before saving.</p></div>}>
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
      <Show when={hasChanges()}><button type="button" class="admin-primary-button" disabled={!canConfirm()} onClick={() => { if (canConfirm()) props.onConfirm(); }}>{props.busy ? 'Saving…' : 'Confirm Save'}</button></Show>
    </div>
  </div>;
};

export default AiRoutingReview;
