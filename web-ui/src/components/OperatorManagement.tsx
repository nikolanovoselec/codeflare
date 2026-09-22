import { For, Show, createEffect, createSignal, onCleanup, untrack, type Component } from 'solid-js';
import * as api from '../api/operator-management';
import { ApiError, apiErrorMessage } from '../api/fetch-helper';
import OperatorManagementActivity from './OperatorManagementActivity';
import '../styles/administration.css';
import '../styles/operator-management.css';

export interface OperatorManagementProps { userEmail?: string; isAdmin?: boolean }
const emptyGrant = (): api.ManagementGrant => ({ users: [], groups: [] });
const emptyPolicy = (): api.ManagementPolicy => ({ capabilities: [], resourceProfileId: null });
const lines = (value: string) => [...new Set(value.split('\n').map(line => line.trim()).filter(Boolean))];
const name = (operator: api.ManagementSummary) => operator.name ?? operator.repositoryUrl ?? operator.id;
const denied = (error: unknown) => error instanceof ApiError && [401, 403, 404].includes(error.status);
function failure(error: unknown, mutation = false): string {
  if (denied(error)) return 'Access denied. Sign in with an authorized account or ask your administrator for access.';
  if (error instanceof ApiError && error.status === 409) return 'This revision is stale. Refresh current state and review it before trying again.';
  if (mutation) return error instanceof ApiError && error.status === 400
    ? 'Invalid source, package or configuration. Check the fields and refresh before trying again.'
    : 'The operation was not confirmed. Refresh current state before retrying; do not assume it succeeded.';
  return apiErrorMessage(error, 'Operators could not be loaded. Retry when the service is available.');
}

/** One bounded catalog/detail flow. Authorization is exclusively enforced by the server. */
const OperatorManagement: Component<OperatorManagementProps> = (props) => {
  const initial = () => new URL(window.location.href);
  const [selected, setSelected] = createSignal(initial().searchParams.get('operator') ?? '');
  const [invocationId, setInvocationId] = createSignal(initial().searchParams.get('invoke') ?? '');
  const [activityView, setActivityView] = createSignal(initial().searchParams.get('view') === 'activity' || !!invocationId());
  const [query, setQuery] = createSignal<api.CatalogQuery>({ query: initial().searchParams.get('query') ?? '',
    cursor: initial().searchParams.get('cursor') ?? '', profile: initial().searchParams.get('profile') ?? '',
    realm: initial().searchParams.get('realm') ?? '', state: initial().searchParams.get('state') ?? '' });
  const [search, setSearch] = createSignal(query().query ?? '');
  const [items, setItems] = createSignal<api.ManagementSummary[]>([]);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [catalogError, setCatalogError] = createSignal<unknown>();
  const [detail, setDetail] = createSignal<api.ManagementDetail>();
  const [detailLoading, setDetailLoading] = createSignal(false);
  const [detailError, setDetailError] = createSignal<unknown>();
  const [registering, setRegistering] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [stale, setStale] = createSignal(false);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [repositoryUrl, setRepositoryUrl] = createSignal('');
  const [pat, setPat] = createSignal('');
  const [profile, setProfile] = createSignal<'conductor' | 'dispatcher'>('conductor');
  const [realm, setRealm] = createSignal<'internal' | 'external'>('internal');
  const [registrationManagers, setRegistrationManagers] = createSignal<api.ManagementGrant>({ users: props.userEmail ? [props.userEmail] : [], groups: [] });
  const [registrationInvokers, setRegistrationInvokers] = createSignal(emptyGrant());
  const [registrationPolicy, setRegistrationPolicy] = createSignal(emptyPolicy());
  let active = true;
  let listRequest = 0;
  let detailRequest = 0;
  let heading: HTMLHeadingElement | undefined;
  let registerButton: HTMLButtonElement | undefined;
  let sourceInput: HTMLInputElement | undefined;
  const locked = () => busy() || stale() || detailLoading();

  function syncUrl(push = true) {
    const url = new URL(window.location.href);
    for (const key of ['query', 'cursor', 'profile', 'realm', 'state']) {
      const value = query()[key as keyof api.CatalogQuery];
      if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    if (selected()) url.searchParams.set('operator', selected()); else url.searchParams.delete('operator');
    window.history[push ? 'pushState' : 'replaceState']({}, '', url);
  }
  function navigate(id: string) {
    setRegistering(false); setPat(''); setError(''); setNotice(''); setStale(false);
    setSelected(id); syncUrl(); queueMicrotask(() => heading?.focus());
  }
  const popstate = () => {
    const url = initial();
    setSelected(url.searchParams.get('operator') ?? '');
    setInvocationId(url.searchParams.get('invoke') ?? '');
    setActivityView(url.searchParams.get('view') === 'activity' || !!invocationId());
    setQuery({ query: url.searchParams.get('query') ?? '', cursor: url.searchParams.get('cursor') ?? '',
      profile: url.searchParams.get('profile') ?? '', realm: url.searchParams.get('realm') ?? '', state: url.searchParams.get('state') ?? '' });
    setSearch(query().query ?? ''); setRegistering(false); setPat(''); setError(''); setNotice(''); setStale(false);
  };
  window.addEventListener('popstate', popstate);
  onCleanup(() => { active = false; setPat(''); window.removeEventListener('popstate', popstate); });
  async function loadCatalog(filter: api.CatalogQuery) {
    const sequence = ++listRequest;
    setLoading(true); setCatalogError(undefined); setItems([]); setCursor(null);
    try {
      const result = await api.listManagedOperators(filter);
      if (active && sequence === listRequest) { setItems(result.items); setCursor(result.cursor); }
      return true;
    } catch (cause) { if (active && sequence === listRequest) setCatalogError(cause); return false; }
    finally { if (active && sequence === listRequest) setLoading(false); }
  }
  async function loadDetail(id: string, clear = false) {
    const sequence = ++detailRequest;
    if (!id) { setDetail(undefined); setDetailLoading(false); return true; }
    if (clear) setDetail(undefined);
    setDetailLoading(true); setDetailError(undefined);
    try {
      const result = await api.getManagedOperator(id);
      if (active && sequence === detailRequest) setDetail(result);
      return true;
    } catch (cause) {
      if (active && sequence === detailRequest) { setDetail(undefined); setDetailError(cause); }
      return false;
    } finally { if (active && sequence === detailRequest) setDetailLoading(false); }
  }
  createEffect(() => { if (!activityView()) void loadCatalog({ ...query() }); });
  createEffect(() => { if (!activityView()) void loadDetail(selected(), true); });
  async function refresh() {
    const results = await Promise.all([loadCatalog(query()), loadDetail(selected())]);
    if (active && results.every(Boolean)) { setStale(false); setError(''); }
  }
  async function perform(action: () => Promise<unknown>, message: string) {
    if (locked()) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await action();
      if (active) { setNotice(message); await refresh(); }
    } catch (cause) {
      if (active) {
        setError(failure(cause, true)); setStale(true);
        if (denied(cause)) { setDetail(undefined); setDetailError(cause); setCatalogError(cause); setItems([]); setRegistering(false); }
      }
    } finally { if (active) { setPat(''); setBusy(false); } }
  }
  const filter = (key: keyof api.CatalogQuery, value: string) => { setQuery({ ...query(), [key]: value, cursor: '' }); syncUrl(); };
  const register = () => { setRegistering(true); setPat(''); queueMicrotask(() => sourceInput?.focus()); };
  const closeRegistration = () => { setRegistering(false); setPat(''); queueMicrotask(() => registerButton?.focus()); };
  const showSection = (activity: boolean) => {
    setActivityView(activity); setSelected(''); setInvocationId(''); setRegistering(false); setPat('');
    if (!activity) {
      setQuery({ query: '', cursor: '', profile: '', realm: '', state: '' });
      setSearch('');
    }
  };

  return <main class="operator-management">
    <div class="admin-page">
      <header class="admin-page-header"><div><p class="admin-eyebrow">Codeflare</p><h1 ref={heading} tabindex="-1">Operators</h1>
        <p>Manage exact releases and named installations. Invocation and activity remain personal.</p></div>
        <nav class="operator-actions" aria-label="Operators navigation"><a href="/app">Back to workspace</a><a href="/operators" onClick={() => showSection(false)}>Catalog</a><a href="/operators?view=activity" onClick={() => showSection(true)}>My activity</a></nav>
      </header>
      <Show when={!activityView()} fallback={<OperatorManagementActivity installationId={invocationId() || undefined} />}>
      <Show when={error()}><div class="operator-message" role="alert" aria-atomic="true"><p>{error()}</p>
        <button class="admin-secondary-button" disabled={busy()} onClick={() => void refresh()}>Refresh current state</button></div></Show>
      <Show when={notice()}><p role="status" class="operator-message">{notice()}</p></Show>
      <Show when={busy()}><p role="status">Saving and reconciling current state…</p></Show>
      <Show when={props.isAdmin && !selected()}><ManagementAccessPanel /></Show>
      <Show when={!selected()} fallback={<>
        <button class="admin-secondary-button" disabled={busy()} onClick={() => navigate('')}>Back to catalog</button>
        <Show when={detailLoading()}><p role="status">Loading operator details…</p></Show>
        <Show when={detailError()}><div role="alert" class="operator-message"><p>{failure(detailError())}</p>
          <button class="admin-secondary-button" disabled={busy()} onClick={() => void refresh()}>Retry details</button></div></Show>
        <Show when={detail()}>{value => <OperatorDetail detail={value()} locked={locked()} perform={perform} />}</Show>
      </>}>
        <section class="admin-panel operator-panel" aria-label="Operator catalog">
          <div class="operator-section-heading"><h2>Catalog</h2><Show when={!denied(catalogError())}>
            <button ref={registerButton} class="admin-primary-button" disabled={busy()} onClick={register}>Register operator</button></Show></div>
          <form class="operator-filters" onSubmit={event => { event.preventDefault(); filter('query', search().trim()); }}>
            <label class="admin-form-field"><span>Search operators</span><input type="search" maxlength="256" value={search()} onInput={event => setSearch(event.currentTarget.value)} /></label>
            <label class="admin-form-field"><span>Profile</span><select value={query().profile ?? ''} onChange={event => filter('profile', event.currentTarget.value)}>
              <option value="">All profiles</option><option value="conductor">Conductor</option><option value="dispatcher">Dispatcher</option></select></label>
            <label class="admin-form-field"><span>Realm</span><select value={query().realm ?? ''} onChange={event => filter('realm', event.currentTarget.value)}>
              <option value="">All realms</option><option value="internal">Internal</option><option value="external">External</option></select></label>
            <label class="admin-form-field"><span>State</span><select value={query().state ?? ''} onChange={event => filter('state', event.currentTarget.value)}>
              <option value="">All states</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></label>
            <button class="admin-secondary-button" type="submit" disabled={loading()}>Search</button>
          </form>
          <Show when={loading()}><p role="status">Loading operators…</p></Show>
          <Show when={catalogError()}><div role="alert" class="operator-message"><p>{failure(catalogError())}</p>
            <button class="admin-secondary-button" onClick={() => void refresh()}>Retry catalog</button>
            <Show when={denied(catalogError())}><a href="/">Sign in again</a></Show></div></Show>
          <Show when={!loading() && !catalogError()}>
            <Show when={items().length} fallback={<p>No operators match this catalog view.</p>}>
              <ul class="operator-list"><For each={items()}>{operator => <li class="admin-area-row">
                <div><strong>{name(operator)}</strong><p>{operator.profile} · {operator.realm} · {operator.enabled ? 'Enabled installations' : 'Disabled'}</p></div>
                <button class="admin-secondary-button" disabled={busy()} aria-label={`Manage ${name(operator)}`} onClick={() => navigate(operator.id)}>Manage</button>
              </li>}</For></ul>
            </Show>
            <nav class="operator-actions" aria-label="Catalog pages"><Show when={query().cursor}>
              <button class="admin-secondary-button" onClick={() => { setQuery({ ...query(), cursor: '' }); syncUrl(); }}>First page</button></Show>
              <Show when={cursor()}><button class="admin-secondary-button" onClick={() => { setQuery({ ...query(), cursor: cursor()! }); syncUrl(); }}>Next page</button></Show>
              <span>Up to 50 permitted operators per page</span></nav>
          </Show>
        </section>
        <Show when={registering() && !denied(catalogError())}>
          <section class="admin-panel operator-panel" aria-label="Register operator"><h2>Register an operator</h2>
            <p>Use a canonical GitHub repository URL and a repository-read PAT. The credential is acquisition-only and never returned. Registration does not approve or enable a release.</p>
            <form onSubmit={event => { event.preventDefault(); void perform(async () => {
              const credential = pat(); setPat('');
              const created = await api.registerManagedOperator({ repositoryUrl: repositoryUrl().trim(), githubPat: credential,
                profile: profile(), realm: realm(), managers: registrationManagers(), invokers: registrationInvokers(), policy: registrationPolicy() });
              if (active) { setRegistering(false); setSelected(created.id); syncUrl(); }
            }, 'Operator registered, disabled and unapproved.'); }}>
              <fieldset disabled={locked()}><div class="admin-form-grid">
                <label class="admin-form-field"><span>GitHub repository URL</span><input ref={sourceInput} type="url" required maxlength="2048" placeholder="https://github.com/owner/repository" value={repositoryUrl()} onInput={event => setRepositoryUrl(event.currentTarget.value)} /></label>
                <label class="admin-form-field"><span>Repository-read PAT</span><input type="password" required maxlength="16384" autocomplete="new-password" value={pat()} onInput={event => setPat(event.currentTarget.value)} /></label>
                <label class="admin-form-field"><span>Operator profile</span><select value={profile()} onChange={event => setProfile(event.currentTarget.value as 'conductor' | 'dispatcher')}><option value="conductor">Conductor</option><option value="dispatcher">Dispatcher</option></select></label>
                <label class="admin-form-field"><span>Operator realm</span><select value={realm()} onChange={event => setRealm(event.currentTarget.value as 'internal' | 'external')}><option value="internal">Internal</option><option value="external">External</option></select></label>
              </div>
              <GrantFields title="Initial manager" value={registrationManagers()} onChange={setRegistrationManagers} />
              <GrantFields title="Initial invoker" value={registrationInvokers()} onChange={setRegistrationInvokers} />
              <PolicyFields title="Operator" value={registrationPolicy()} onChange={setRegistrationPolicy} />
              <div class="operator-actions"><button class="admin-primary-button" type="submit">Register disabled operator</button></div>
              </fieldset>
              <button class="admin-secondary-button" type="button" disabled={busy()} onClick={closeRegistration}>Cancel registration</button>
            </form>
          </section>
        </Show>
      </Show>
      </Show>
    </div>
  </main>;
};

const LineField: Component<{ label: string; values: string[]; onChange: (values: string[]) => void; hint: string; email?: boolean }> = props => {
  const [draft, setDraft] = createSignal('');
  createEffect(() => {
    const value = props.values.join('\n');
    if (untrack(() => lines(draft()).join('\n')) !== value) setDraft(value);
  });
  return <label class="admin-form-field"><span>{props.label}</span><textarea aria-label={props.label} rows="3" maxlength="32768" value={draft()} onInput={event => {
    const value = event.currentTarget.value; setDraft(value);
    const entries = lines(value);
    event.currentTarget.setCustomValidity(props.email && entries.some(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ? 'Use one valid email per line.' : '');
    props.onChange(entries);
  }} /><small>{props.hint}</small></label>;
};
const GrantFields: Component<{ title: string; value: api.ManagementGrant; onChange: (value: api.ManagementGrant) => void }> = props => {
  const [groupText, setGroupText] = createSignal('');
  createEffect(() => {
    const value = props.value.groups.map(group => `${group.issuer} ${group.id}`).join('\n');
    if (untrack(() => lines(groupText()).map(line => line.split(/\s+/).join(' ')).join('\n')) !== value) setGroupText(value);
  });
  return <fieldset class="operator-fields"><legend>{props.title} grants</legend><div class="admin-form-grid">
    <LineField label={`${props.title} users`} values={props.value.users} onChange={users => props.onChange({ ...props.value, users })} email hint="One email per line. An empty list grants no user access." />
    <label class="admin-form-field"><span>{props.title} groups</span><textarea aria-label={`${props.title} groups`} rows="3" maxlength="32768" value={groupText()} placeholder="https://team.cloudflareaccess.com stable-group-id" onInput={event => {
      const value = event.currentTarget.value; setGroupText(value);
      const entries = lines(value).map(line => line.split(/\s+/));
      const valid = entries.every(parts => parts.length === 2 && /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(parts[0]) && parts[1].length <= 256);
      event.currentTarget.setCustomValidity(valid ? '' : 'Use one trusted Access issuer and stable group ID per line.');
      if (valid) props.onChange({ ...props.value, groups: entries.map(([issuer, id]) => ({ issuer, id })) });
    }} /><small>One issuer and stable ID per line, separated by a space. Display names do not grant access.</small></label>
  </div></fieldset>;
};
const PolicyFields: Component<{ title: string; value: api.ManagementPolicy; onChange: (value: api.ManagementPolicy) => void }> = props => <fieldset class="operator-fields"><legend>{props.title} restrictions</legend>
  <div class="admin-form-grid"><LineField label={`${props.title} capabilities`} values={props.value.capabilities} onChange={capabilities => props.onChange({ ...props.value, capabilities })} hint="One permitted capability per line. Empty denies all capabilities." />
    <label class="admin-form-field"><span>{props.title} resource profile ID</span><input aria-label={`${props.title} resource profile ID`} value={props.value.resourceProfileId ?? ''} maxlength="128" pattern="[A-Za-z0-9_-]+" onInput={event => props.onChange({ ...props.value, resourceProfileId: event.currentTarget.value || null })} /><small>Installation restrictions cannot expand operator or human authority.</small></label></div>
</fieldset>;

const OperatorDetail: Component<{ detail: api.ManagementDetail; locked: boolean; perform: (action: () => Promise<unknown>, message: string) => Promise<void> }> = props => {
  const [managers, setManagers] = createSignal(emptyGrant());
  const [invokers, setInvokers] = createSignal(emptyGrant());
  const [installationName, setInstallationName] = createSignal('');
  const [policy, setPolicy] = createSignal(emptyPolicy());
  const [sourceUrl, setSourceUrl] = createSignal('');
  const [sourcePat, setSourcePat] = createSignal('');
  const [releaseSelections, setReleaseSelections] = createSignal<Record<string, string>>({});
  createEffect(() => {
    setManagers(props.detail.grants.managers); setInvokers(props.detail.grants.invokers);
    setSourceUrl(props.detail.operator.repositoryUrl); setSourcePat('');
  });
  onCleanup(() => setSourcePat(''));
  const operator = () => props.detail.operator;
  return <>
    <section class="admin-panel operator-panel"><h2>{name(operator())}</h2><p>{operator().profile} · {operator().realm} · Revision {operator().revision}</p>
      <p>Source: {operator().repositoryUrl} · Repository ID {operator().repositoryId}</p>
      <p>Source credential: {operator().source.credentialConfigured ? 'Configured (write-only)' : 'Not configured'}</p>
      <p>Approved workflow: {operator().source.approvedWorkflow ? `${operator().source.approvedWorkflow!.id} · ${operator().source.approvedWorkflow!.ref}` : 'Not selected'}</p>
      <p>Operator capability ceiling: {operator().policy.capabilities.join(', ') || 'None'}</p>
      <p>Resource profile: {operator().policy.resourceProfileId ?? 'None'}</p>
      <details><summary>Edit source</summary><p>Replacing source or trust invalidates approval and disables new starts. Approve exact releases again before enabling.</p>
        <form onSubmit={event => { event.preventDefault(); void props.perform(async () => {
          const credential = sourcePat(); setSourcePat('');
          await api.replaceOperatorSource(operator().id, { revision: operator().revision, repositoryUrl: sourceUrl().trim(), githubPat: credential });
        }, 'Source replaced. Discover and approve releases again before enabling.'); }}>
          <fieldset disabled={props.locked}><div class="admin-form-grid">
            <label class="admin-form-field"><span>Replacement repository URL</span><input type="url" required maxlength="2048" value={sourceUrl()} onInput={event => setSourceUrl(event.currentTarget.value)} /></label>
            <label class="admin-form-field"><span>Replacement repository-read PAT</span><input type="password" required maxlength="16384" autocomplete="new-password" value={sourcePat()} onInput={event => setSourcePat(event.currentTarget.value)} /></label>
          </div><button class="admin-secondary-button" type="submit">Replace source</button></fieldset>
        </form>
      </details>
    </section>
    <section class="admin-panel operator-panel"><div class="operator-section-heading"><h2>Releases</h2>
      <button class="admin-secondary-button" disabled={props.locked} onClick={() => void props.perform(() => api.refreshManagedReleases(operator().id, operator().revision), 'Release discovery refreshed. Nothing was approved or enabled.')}>Refresh releases</button></div>
      <p>Discovery is not approval. Approve and pin an exact release to an installation, then enable it separately.</p>
      <Show when={props.detail.releases.length} fallback={<p>No releases discovered.</p>}><ul class="operator-list"><For each={props.detail.releases}>{release => <li>
        <strong>{release.version ?? release.name ?? release.id}</strong><p>{release.approved ? 'Approved' : 'Discovered · not approved'} · GitHub release {release.githubReleaseId}</p>
        <Show when={release.coreVersion && release.intentVersion}><p>Core {release.coreVersion} · Intent {release.intentVersion} · Interface {release.interfaceVersion}</p></Show>
        <dl class="operator-facts"><dt>Source commit</dt><dd>{release.sourceCommit}</dd><dt>Bundle SHA-256</dt><dd>{release.bundleDigest}</dd><dt>Manifest SHA-256</dt><dd>{release.manifestDigest}</dd>
          <dt>Requested capabilities</dt><dd>{release.requestedCapabilities?.join(', ') || 'Not reported by discovery'}</dd></dl>
      </li>}</For></ul></Show>
    </section>
    <section class="admin-panel operator-panel"><h2>Installations</h2><p>Names are local labels. Promotion affects new activities only and leaves the installation disabled.</p>
      <Show when={props.detail.installations.length} fallback={<p>No installations yet.</p>}><For each={props.detail.installations}>{installation => <InstallationEditor installation={installation} releases={props.detail.releases} releaseId={releaseSelections()[installation.id] ?? ''} onReleaseChange={releaseId => setReleaseSelections(selections => ({ ...selections, [installation.id]: releaseId }))} locked={props.locked} perform={props.perform} />}</For></Show>
      <form onSubmit={event => { event.preventDefault(); void props.perform(async () => { await api.createInstallation(operator().id, { name: installationName().trim(), policy: policy(), revision: operator().revision }); setInstallationName(''); }, 'Disabled installation created. Approve a release before enabling.'); }}>
        <fieldset disabled={props.locked}><legend>Create installation</legend>
          <label class="admin-form-field"><span>Installation name</span><input required maxlength="256" value={installationName()} onInput={event => setInstallationName(event.currentTarget.value)} /></label>
          <PolicyFields title="Installation" value={policy()} onChange={setPolicy} />
          <button type="submit" class="admin-primary-button">Create disabled installation</button>
        </fieldset>
      </form>
    </section>
    <section class="admin-panel operator-panel"><h2>Access grants</h2><p>Managers also need global management eligibility. Manager grants never permit invocation or access to another person's activities.</p>
      <form onSubmit={event => { event.preventDefault(); void props.perform(() => api.saveOperatorGrants(operator().id, { managers: managers(), invokers: invokers(), revision: operator().revision }), 'Grants saved. Management does not grant invocation.'); }}>
        <fieldset disabled={props.locked}><GrantFields title="Manager" value={managers()} onChange={setManagers} /><GrantFields title="Invoker" value={invokers()} onChange={setInvokers} />
          <button class="admin-primary-button" type="submit">Save grants</button></fieldset>
      </form>
    </section>
  </>;
};
const InstallationEditor: Component<{ installation: api.ManagementInstallation; releases: api.ManagementRelease[]; releaseId: string;
  onReleaseChange: (releaseId: string) => void; locked: boolean; perform: (action: () => Promise<unknown>, message: string) => Promise<void> }> = props => {
  const [policy, setPolicy] = createSignal(emptyPolicy());
  const [configuration, setConfiguration] = createSignal('{}');
  const [validation, setValidation] = createSignal('');
  createEffect(() => { setPolicy(props.installation.policy); setConfiguration(JSON.stringify(props.installation.configuration ?? {}, null, 2)); });
  const installation = () => props.installation;
  function configure() {
    let value: unknown;
    try {
      if (new TextEncoder().encode(configuration()).byteLength > 65536) throw new Error('Too large');
      value = JSON.parse(configuration());
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Not an object');
      setValidation('');
    } catch { setValidation('Configuration must be a JSON object, at most 64 KiB.'); return; }
    void props.perform(() => api.configureInstallation(installation().id, { revision: installation().revision, policy: policy(), configuration: value }), 'Installation configuration saved. Review current state before enabling.');
  }
  return <article class="operator-installation"><h3>{installation().name}</h3><p>{installation().enabled ? 'Enabled for new activities' : 'Disabled'} · Revision {installation().revision}</p>
    <p>Pinned release: {installation().releaseId ?? 'None'}</p>
    <Show when={props.releases.find(release => release.id === installation().releaseId)}>{release => <>
      <p>Pinned version: Core {release().coreVersion ?? 'not reported'} · Intent {release().intentVersion ?? 'not reported'}</p>
      <p>Bundle SHA-256: {release().bundleDigest}</p>
    </>}</Show>
    <p>Granted capabilities: {installation().policy.capabilities.join(', ') || 'None'}</p>
    <p>Resource profile: {installation().policy.resourceProfileId ?? 'None'}</p>
    <label class="admin-form-field"><span>Release for {installation().name}</span><select disabled={props.locked} value={props.releaseId} onChange={event => props.onReleaseChange(event.currentTarget.value)}>
      <option value="">Select exact release</option><For each={props.releases}>{release => <option value={release.id}>{release.version ?? release.id} · {release.approved ? 'approved' : 'requires approval'}</option>}</For></select></label>
    <div class="operator-actions"><button class="admin-secondary-button" disabled={props.locked || !props.releaseId} aria-label={`Approve and promote ${installation().name}`} onClick={() => void props.perform(async () => {
      await api.promoteInstallation(installation().id, props.releaseId, installation().revision);
      props.onReleaseChange('');
    }, 'Release approved and pinned. Enable the installation separately.')}>Approve and promote</button>
      <button class="admin-primary-button" disabled={props.locked || !installation().releaseId} aria-label={`${installation().enabled ? 'Disable' : 'Enable'} ${installation().name}`} onClick={() => void props.perform(() => api.enableInstallation(installation().id, !installation().enabled, installation().revision), installation().enabled ? 'Installation disabled for new activities.' : 'Installation enabled.')}>{installation().enabled ? 'Disable' : 'Enable'}</button>
      <Show when={installation().enabled}><a href={`/operators?invoke=${encodeURIComponent(installation().id)}`}>Invoke as yourself</a></Show>
    </div>
    <details><summary>Configure {installation().name}</summary><p>Configuration and restrictions are pinned for each activity. Do not include credentials or reusable tokens.</p>
      <Show when={validation()}><p role="alert">{validation()}</p></Show>
      <form onSubmit={event => { event.preventDefault(); configure(); }}><fieldset disabled={props.locked}>
        <PolicyFields title={installation().name} value={policy()} onChange={setPolicy} />
        <label class="admin-form-field"><span>Configuration JSON for {installation().name}</span><textarea rows="6" maxlength="65536" required value={configuration()} onInput={event => setConfiguration(event.currentTarget.value)} /></label>
        <button class="admin-secondary-button" type="submit" aria-label={`Save configuration for ${installation().name}`}>Save configuration</button>
      </fieldset></form>
    </details>
  </article>;
};

const ManagementAccessPanel: Component = () => {
  const [current, setCurrent] = createSignal<api.ManagementAccess>();
  const [managers, setManagers] = createSignal(emptyGrant());
  const [capabilities, setCapabilities] = createSignal('');
  const [resources, setResources] = createSignal('');
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [stale, setStale] = createSignal(false);
  let active = true;
  onCleanup(() => { active = false; });
  function populate(value: api.ManagementAccess) {
    setCurrent(value); setManagers(value.managers); setCapabilities(value.ceiling.capabilities.join('\n')); setResources(value.ceiling.resourceProfileIds.join('\n'));
  }
  async function load() {
    setLoading(true); setError('');
    try { const value = await api.getManagementAccess(); if (active) { populate(value); setStale(false); } }
    catch (cause) { if (active) { setCurrent(undefined); setError(failure(cause)); } }
    finally { if (active) setLoading(false); }
  }
  void load();
  async function save() {
    if (busy() || stale() || !current()) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const value = await api.saveManagementAccess({ revision: current()!.revision, managers: managers(),
        ceiling: { capabilities: lines(capabilities()), resourceProfileIds: lines(resources()) } });
      if (active) { populate(value); setNotice('Management access saved. Operator ownership and invocation grants remain separate.'); }
    } catch (cause) { if (active) { setError(failure(cause, true)); setStale(true); } }
    finally { if (active) setBusy(false); }
  }
  return <section class="admin-panel operator-panel"><h2>Management access</h2>
    <p>Platform administrators delegate management eligibility and set the deployment security ceiling. Empty lists deny access. A manager still needs ownership of each operator.</p>
    <Show when={loading()}><p role="status">Loading management access…</p></Show>
    <Show when={error()}><div role="alert" class="operator-message"><p>{error()}</p><button class="admin-secondary-button" disabled={busy()} onClick={() => void load()}>Refresh management access</button></div></Show>
    <Show when={notice()}><p role="status">{notice()}</p></Show>
    <Show when={current()}><form onSubmit={event => { event.preventDefault(); void save(); }}><fieldset disabled={busy() || loading() || stale()}>
      <GrantFields title="Eligible manager" value={managers()} onChange={setManagers} />
      <div class="admin-form-grid"><label class="admin-form-field"><span>Security ceiling capabilities</span><textarea aria-label="Security ceiling capabilities" rows="3" maxlength="32768" value={capabilities()} onInput={event => setCapabilities(event.currentTarget.value)} /><small>One capability per line. Operator and installation policies may only restrict this list.</small></label>
        <label class="admin-form-field"><span>Security ceiling resource profile IDs</span><textarea aria-label="Security ceiling resource profile IDs" rows="3" maxlength="32768" value={resources()} onInput={event => setResources(event.currentTarget.value)} /><small>One stable resource profile ID per line. A null installation profile requests none.</small></label></div>
      <p>Revision {current()!.revision}</p><button type="submit" class="admin-primary-button">Save management access</button>
    </fieldset></form></Show>
  </section>;
};
export default OperatorManagement;
