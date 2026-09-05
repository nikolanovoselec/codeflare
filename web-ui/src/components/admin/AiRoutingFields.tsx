/* v8 ignore start -- user-validated administration UI */
import { For, Show, createMemo, createSignal, onMount, type Component } from 'solid-js';
import {
  discoverReasoningCompatibility,
  getReasoningCatalog,
  getReasoningRouteInventory,
} from '../../api/client';
import type {
  PiReasoningLevel,
  ProfileRevisionRef,
  ReasoningCatalog,
  ReasoningConfiguration,
  ReasoningDiscoveryResult,
  ReasoningProfileCatalogEntry,
  ReasoningRouteAssignment,
  ReasoningRouteInventory,
  ReasoningRouteLeg,
} from '../../types';
import ReasoningProfileEditor from './ReasoningProfileEditor';

interface Props { current: unknown }
interface GroupDraft { accessGroup: string; routes: string[]; defaultRoute: string; reasoning: PiReasoningLevel }
interface AssignmentDraft extends Omit<ReasoningRouteAssignment, 'activeProfile'> { activeProfile?: ProfileRevisionRef }
interface RouteDraft {
  name: string;
  contextWindow: number;
  assignment: AssignmentDraft;
  inventory?: ReasoningRouteInventory;
  inventoryBusy?: boolean;
  inventoryError?: string;
  discoveryOpen?: boolean;
  discoveryBusy?: boolean;
  discoveryCeiling?: number;
  discoveryResult?: ReasoningDiscoveryResult;
  discoveryError?: string;
}

const LEVELS: PiReasoningLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_CONTEXT_WINDOW = 256000;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function stringList(value: unknown): string[] { return Array.isArray(value) ? value.map(String) : []; }
function isLevel(value: unknown): value is PiReasoningLevel { return LEVELS.includes(value as PiReasoningLevel); }
function profileRef(value: unknown): ProfileRevisionRef | undefined {
  const candidate = record(value);
  return typeof candidate.id === 'string' && typeof candidate.revision === 'number' && typeof candidate.hash === 'string'
    ? { id: candidate.id, revision: candidate.revision, hash: candidate.hash }
    : undefined;
}
function routeAssignment(value: unknown): AssignmentDraft {
  const candidate = record(value);
  const legs = Array.isArray(candidate.legs) ? candidate.legs.map((item) => {
    const leg = record(item);
    return {
      nodeId: text(leg.nodeId),
      provider: text(leg.provider),
      declaredModel: text(leg.declaredModel),
      ...(text(leg.customProviderBackend) && { customProviderBackend: text(leg.customProviderBackend) }),
      ...(profileRef(leg.profileRef) && { profileRef: profileRef(leg.profileRef) }),
      ...(leg.evidence !== undefined && { evidence: record(leg.evidence) }),
    } satisfies ReasoningRouteLeg;
  }) : undefined;
  return {
    ...(profileRef(candidate.activeProfile) && { activeProfile: profileRef(candidate.activeProfile) }),
    ...(text(candidate.routeVersion) && { routeVersion: text(candidate.routeVersion) }),
    ...(legs && { legs }),
    ...(candidate.commonMapping && { commonMapping: candidate.commonMapping as ReasoningRouteAssignment['commonMapping'] }),
  };
}
function groupDrafts(value: unknown): GroupDraft[] {
  const source = Array.isArray(value)
    ? value
    : Object.entries(record(value)).map(([accessGroup, routing]) => ({ accessGroup, ...record(routing) }));
  return source.map((item) => {
    const group = record(item);
    const reasoning = isLevel(group.reasoning) ? group.reasoning : 'off';
    return { accessGroup: text(group.accessGroup), routes: stringList(group.routes), defaultRoute: text(group.defaultRoute), reasoning };
  }).filter((group) => group.accessGroup);
}
function refKey(ref: ProfileRevisionRef | undefined): string {
  return ref ? `${ref.id}\u001f${ref.revision}\u001f${ref.hash}` : '';
}
function profileRefFromEntry(profile: ReasoningProfileCatalogEntry): ProfileRevisionRef {
  return { id: profile.id, revision: profile.revision, hash: profile.hash };
}
function offSummary(profile: ReasoningProfileCatalogEntry): string {
  if (!profile.supportedLevels.includes('off')) return 'Off unsupported';
  if (typeof profile.offSemantics === 'string') return `Off: ${profile.offSemantics}`;
  return `Off: ${profile.offSemantics?.status ?? 'explicit mapping'}`;
}
function evidenceSummary(leg: ReasoningRouteLeg): string {
  if (leg.evidence?.status) return String(leg.evidence.status);
  if (leg.evidence?.current === false) return 'Stale';
  if (leg.evidence?.toolReplay === true) return 'Tool replay verified';
  return 'No current evidence';
}

const AiRoutingFields: Component<Props> = (props) => {
  const current = record(props.current);
  const configuration = record(current.reasoningConfiguration);
  const assignments = record(configuration.routeAssignments);
  const contextWindows = record(current.routeContextWindows);
  const configuredRoutes = stringList(current.dynamicRoutes);
  const [gatewayRoutes, setGatewayRoutes] = createSignal<string[]>([]);
  const [routes, setRoutes] = createSignal<RouteDraft[]>(configuredRoutes.map((name) => ({
    name,
    contextWindow: typeof contextWindows[name] === 'number' ? contextWindows[name] as number : DEFAULT_CONTEXT_WINDOW,
    assignment: routeAssignment(assignments[name]),
  })));
  const storedDefault = record(current.defaultRoute);
  const [defaultRoute, setDefaultRoute] = createSignal(text(storedDefault.route));
  const [defaultReasoning, setDefaultReasoning] = createSignal<PiReasoningLevel>(isLevel(storedDefault.reasoning) ? storedDefault.reasoning : 'off');
  const availableAccessGroups = stringList(current.availableAccessGroups);
  const [groups, setGroups] = createSignal<GroupDraft[]>(groupDrafts(current.groupRouting));
  const [groupToAdd, setGroupToAdd] = createSignal(availableAccessGroups.find((group) => !groups().some((draft) => draft.accessGroup === group)) ?? '');
  const [customRevisions, setCustomRevisions] = createSignal<Array<Record<string, unknown>>>(Array.isArray(configuration.customProfileRevisions) ? configuration.customProfileRevisions.map(record) : []);
  const [catalog, setCatalog] = createSignal<ReasoningCatalog>({ schemaVersion: 1, profiles: [], notices: [], usage: [], routes: [], routeCatalogStatus: 'unavailable' });
  const [catalogBusy, setCatalogBusy] = createSignal(true);
  const [catalogError, setCatalogError] = createSignal('');
  const [pendingRemoval, setPendingRemoval] = createSignal<string>();
  const [applyGroupsOpen, setApplyGroupsOpen] = createSignal(false);
  const [applyGroupSource, setApplyGroupSource] = createSignal(groups()[0]?.accessGroup ?? '');
  const [profileEditorOpen, setProfileEditorOpen] = createSignal(false);

  onMount(async () => {
    try {
      const loaded = await getReasoningCatalog();
      setCatalog(loaded);
      if (loaded.routeCatalogStatus === 'ready') {
        setGatewayRoutes(loaded.routes);
        setRoutes((items) => {
          const byName = new Map(items.map((route) => [route.name, route]));
          const discovered = loaded.routes.map((name) => byName.get(name) ?? { name, contextWindow: DEFAULT_CONTEXT_WINDOW, assignment: {} });
          return [...discovered, ...items.filter((route) => !loaded.routes.includes(route.name))];
        });
        if (!defaultRoute() && loaded.routes[0]) setDefaultRoute(loaded.routes[0]);
      }
    } catch (reason) {
      setCatalogError(reason instanceof Error ? reason.message : 'Capability profile catalog could not be loaded.');
    } finally {
      setCatalogBusy(false);
    }
  });

  const assignableProfiles = createMemo(() => catalog().profiles.filter((profile) => profile.enabled !== false && profile.assignable !== false));
  const findProfile = (ref: ProfileRevisionRef | undefined) => assignableProfiles().find((profile) => refKey(profileRefFromEntry(profile)) === refKey(ref));
  const routeByName = (name: string) => routes().find((route) => route.name === name);
  const supportedLevels = (routeName: string): PiReasoningLevel[] => findProfile(routeByName(routeName)?.assignment.activeProfile)?.supportedLevels ?? [];
  const updateRoute = (name: string, update: (route: RouteDraft) => RouteDraft) => setRoutes((items) => items.map((route) => route.name === name ? update(route) : route));

  const setRouteProfile = (name: string, key: string) => {
    const selected = assignableProfiles().find((profile) => refKey(profileRefFromEntry(profile)) === key);
    const selectedRef = selected ? profileRefFromEntry(selected) : undefined;
    updateRoute(name, (route) => ({
      ...route,
      assignment: {
        ...route.assignment,
        ...(selectedRef ? { activeProfile: selectedRef } : { activeProfile: undefined }),
        ...(route.assignment.legs && { legs: route.assignment.legs.map((leg) => (
          selectedRef && !leg.profileRef ? { ...leg, profileRef: selectedRef } : leg
        )) }),
      },
    }));
    if (defaultRoute() === name && !selected?.supportedLevels.includes(defaultReasoning())) {
      setDefaultReasoning(selected?.supportedLevels[0] ?? 'off');
    }
    setGroups((items) => items.map((group) => group.defaultRoute === name && !selected?.supportedLevels.includes(group.reasoning)
      ? { ...group, reasoning: selected?.supportedLevels[0] ?? 'off' }
      : group));
  };

  const removalImpact = (name: string): string[] => {
    const impact = groups().filter((group) => group.routes.includes(name)).map((group) => group.accessGroup);
    if (defaultRoute() === name) impact.unshift('global default');
    return impact;
  };
  const removalBlockReason = (name: string): string => {
    if (routes().length === 1) return 'At least one route must remain in the catalog.';
    const emptyGroups = groups().filter((group) => group.routes.length === 1 && group.routes[0] === name).map((group) => group.accessGroup);
    return emptyGroups.length > 0 ? `Add another allowed route to ${emptyGroups.join(', ')} before removing this route.` : '';
  };

  const confirmRemove = (name: string) => {
    const remaining = routes().filter((route) => route.name !== name);
    setRoutes(remaining);
    const replacement = remaining[0]?.name ?? '';
    if (defaultRoute() === name) {
      setDefaultRoute(replacement);
      setDefaultReasoning(replacement ? supportedLevels(replacement)[0] ?? 'off' : 'off');
    }
    setGroups((items) => items.map((group) => {
      const selected = group.routes.filter((route) => route !== name);
      const nextDefault = group.defaultRoute === name ? selected[0] ?? '' : group.defaultRoute;
      return { ...group, routes: selected, defaultRoute: nextDefault, reasoning: nextDefault ? (group.defaultRoute === name ? supportedLevels(nextDefault)[0] ?? 'off' : group.reasoning) : 'off' };
    }));
    setPendingRemoval(undefined);
  };

  const toggleGroupRoute = (accessGroup: string, route: string) => setGroups((items) => items.map((group) => {
    if (group.accessGroup !== accessGroup) return group;
    const selected = group.routes.includes(route) ? group.routes.filter((item) => item !== route) : [...group.routes, route];
    const nextDefault = selected.includes(group.defaultRoute) ? group.defaultRoute : selected[0] ?? '';
    return { ...group, routes: selected, defaultRoute: nextDefault, reasoning: nextDefault === group.defaultRoute ? group.reasoning : supportedLevels(nextDefault)[0] ?? 'off' };
  }));

  const copyGroupToAll = () => {
    const source = groups().find((group) => group.accessGroup === applyGroupSource());
    if (source) setGroups((items) => items.map((group) => ({ ...group, routes: [...source.routes], defaultRoute: source.defaultRoute, reasoning: source.reasoning })));
    setApplyGroupsOpen(false);
  };

  const unconfiguredGroups = createMemo(() => availableAccessGroups.filter((group) => !groups().some((draft) => draft.accessGroup === group)));
  const addGroupPolicy = () => {
    const accessGroup = groupToAdd();
    if (!accessGroup || !unconfiguredGroups().includes(accessGroup)) return;
    const selectedRoutes = routes().map((route) => route.name);
    const selectedDefault = selectedRoutes.includes(defaultRoute()) ? defaultRoute() : selectedRoutes[0] ?? '';
    const levels = supportedLevels(selectedDefault);
    setGroups((items) => [...items, {
      accessGroup,
      routes: selectedRoutes,
      defaultRoute: selectedDefault,
      reasoning: levels.includes(defaultReasoning()) ? defaultReasoning() : levels[0] ?? 'off',
    }]);
    setGroupToAdd(unconfiguredGroups().find((group) => group !== accessGroup) ?? '');
  };

  const inspect = async (name: string) => {
    updateRoute(name, (route) => ({ ...route, inventoryBusy: true, inventoryError: undefined }));
    try {
      const inventory = await getReasoningRouteInventory(name);
      updateRoute(name, (route) => {
        const previousLegs = route.assignment.legs ?? [];
        const nextVersion = inventory.routeVersion ?? inventory.versionId;
        const versionChanged = Boolean(route.assignment.routeVersion && nextVersion && route.assignment.routeVersion !== nextVersion);
        const legs = inventory.legs.map((leg) => {
          const previous = previousLegs.find((item) => item.nodeId === leg.nodeId);
          const evidence = leg.evidence ?? previous?.evidence;
          return {
            nodeId: leg.nodeId,
            provider: leg.provider,
            declaredModel: leg.declaredModel,
            ...((leg.customProviderBackend ?? previous?.customProviderBackend) && { customProviderBackend: leg.customProviderBackend ?? previous?.customProviderBackend }),
            profileRef: leg.profileRef ?? previous?.profileRef ?? route.assignment.activeProfile,
            ...(evidence && { evidence: versionChanged ? { ...evidence, current: false, status: 'stale' } : evidence }),
          } satisfies ReasoningRouteLeg;
        });
        return {
          ...route,
          inventory,
          inventoryBusy: false,
          assignment: {
            ...route.assignment,
            routeVersion: nextVersion,
            legs,
            commonMapping: inventory.commonMapping ?? (versionChanged ? undefined : route.assignment.commonMapping),
          },
        };
      });
    } catch (reason) {
      updateRoute(name, (route) => ({ ...route, inventoryBusy: false, inventoryError: reason instanceof Error ? reason.message : 'Route inventory failed.' }));
    }
  };

  const setLeg = (routeName: string, nodeId: string, patch: Partial<ReasoningRouteLeg>) => updateRoute(routeName, (route) => ({
    ...route,
    assignment: { ...route.assignment, legs: (route.assignment.legs ?? []).map((leg) => leg.nodeId === nodeId ? { ...leg, ...patch } : leg) },
  }));

  const discover = async (name: string) => {
    const route = routeByName(name);
    const activeProfile = route?.assignment.activeProfile;
    if (!route || !activeProfile) {
      updateRoute(name, (item) => ({ ...item, discoveryError: 'Select a capability profile before discovery.' }));
      return;
    }
    const ceiling = route.discoveryCeiling ?? 32;
    updateRoute(name, (item) => ({ ...item, discoveryBusy: true, discoveryError: undefined, discoveryResult: undefined }));
    try {
      const result = await discoverReasoningCompatibility({ route: name, profileRef: activeProfile, maxCompletionTokens: ceiling });
      updateRoute(name, (item) => ({ ...item, discoveryBusy: false, discoveryResult: result }));
    } catch (reason) {
      updateRoute(name, (item) => ({ ...item, discoveryBusy: false, discoveryError: reason instanceof Error ? reason.message : 'Discovery failed.' }));
    }
  };

  const useDiscoveryEvidence = (name: string) => {
    const route = routeByName(name);
    const evidence = route?.discoveryResult?.evidence;
    const legs = route?.assignment.legs ?? [];
    if (!route || !evidence || legs.length !== 1 || !route.assignment.activeProfile) {
      updateRoute(name, (item) => ({ ...item, discoveryError: 'Evidence can be attached only after inventory confirms one separately addressable route leg.' }));
      return;
    }
    updateRoute(name, (item) => ({
      ...item,
      discoveryError: undefined,
      assignment: {
        ...item.assignment,
        commonMapping: undefined,
        legs: (item.assignment.legs ?? []).map((leg) => ({
          ...leg,
          profileRef: item.assignment.activeProfile,
          evidence: { ...evidence },
        })),
      },
    }));
  };

  const serializedConfiguration = createMemo<ReasoningConfiguration>(() => ({
    schemaVersion: 1,
    customProfileRevisions: customRevisions(),
    routeAssignments: Object.fromEntries(routes().flatMap((route) => route.assignment.activeProfile ? [[route.name, {
      ...route.assignment,
      activeProfile: route.assignment.activeProfile,
    } satisfies ReasoningRouteAssignment]] : [])),
  }));

  return <div class="admin-ai-routing admin-form-wide">
    <section class="admin-routing-section" aria-labelledby="gateway-heading">
      <div class="admin-subsection-heading"><div><h3 id="gateway-heading">Gateway connection</h3><p>Blank replacement token fields preserve the stored credential.</p></div></div>
      <div class="admin-profile-grid">
        <label class="admin-form-field"><span>AI Gateway URL</span><input name="gatewayUrl" type="url" value={text(current.gatewayUrl)} /></label>
        <label class="admin-form-field"><span>Replacement API token</span><input name="replacementToken" type="password" value="" autocomplete="new-password" /></label>
        <div class="admin-readonly-field"><span>Effective credential source</span><strong>{current.tokenState === 'administration' ? 'Administration-managed token' : current.tokenState === 'deployment' ? 'Deployment token' : 'Token required'}</strong><small>The token value is never returned to this page.</small></div>
        <div class="admin-readonly-field"><span>Connection readiness</span><strong>{text(current.gatewayUrl) && current.tokenState !== 'none' ? 'Configured' : 'Action required'}</strong><small>Inventory and discovery use the effective Worker-side gateway credentials.</small></div>
      </div>
    </section>

    <section class="admin-routing-section" aria-labelledby="catalog-heading">
      <div class="admin-subsection-heading"><div><h3 id="catalog-heading">Route catalog</h3><p>Routes are discovered automatically from the configured AI Gateway. Every route needs a context window and one route-wide capability profile.</p></div><button type="button" class="admin-secondary-button" onClick={() => setProfileEditorOpen(true)}>Create custom profile</button></div>
      <Show when={catalogBusy()}><p class="admin-status-text" role="status">Loading capability profiles…</p></Show>
      <Show when={catalogError()}><div class="admin-inline-error" role="alert">{catalogError()}</div></Show>
      <Show when={!catalogBusy() && catalog().routeCatalogStatus === 'unavailable'}><div class="admin-inline-error" role="alert">Dynamic routes could not be read. Verify the saved token has AI Gateway Read permission.</div></Show>

      <div class="admin-route-list"><For each={routes()}>{(route) => {
        const selectedProfile = () => findProfile(route.assignment.activeProfile);
        const inventoryLegs = () => route.assignment.legs ?? [];
        const commonLevels = () => route.assignment.commonMapping
          ? LEVELS.filter((level) => route.assignment.commonMapping?.levels[level])
          : route.inventory?.commonLevels ?? [];
        return <article class="admin-route-card">
          <div class="admin-route-card-heading"><div><h4>{route.name}</h4><Show when={selectedProfile()}>{(profile) => <span class="admin-status">{profile().classification ?? 'Unclassified'}</span>}</Show></div><Show when={!gatewayRoutes().includes(route.name)}><button type="button" class="admin-link-button admin-danger-link" aria-label={`Remove ${route.name} stale route`} onClick={() => setPendingRemoval(route.name)}>Remove stale route</button></Show></div>
          <div class="admin-route-controls">
            <label class="admin-form-field"><span>Context window</span><input name="routeContextWindow" type="number" min="1" step="1" aria-label={`${route.name} context window`} value={route.contextWindow} onInput={(event) => updateRoute(route.name, (item) => ({ ...item, contextWindow: Number(event.currentTarget.value) }))} /></label>
            <input type="hidden" name="routeContextRoute" value={route.name} />
            <label class="admin-form-field"><span>Active route-wide profile</span><select aria-label={`${route.name} capability profile`} value={refKey(route.assignment.activeProfile)} disabled={catalogBusy() || Boolean(catalogError())} onChange={(event) => setRouteProfile(route.name, event.currentTarget.value)}><option value="">Select capability profile</option><For each={assignableProfiles()}>{(profile) => <option value={refKey(profileRefFromEntry(profile))}>{profile.name} · revision {profile.revision}</option>}</For></select></label>
          </div>
          <Show when={selectedProfile()}>{(profile) => <div class="admin-profile-summary"><strong>Selected: {profile().name}</strong><span>Supported levels: {profile().supportedLevels.join(', ')}</span><span>{offSummary(profile())}</span><span>Pi tools: {profile().toolCompatibility?.status ?? 'No current evidence'}</span><Show when={profile().validatedTransports?.length}><span>Validated transport: {profile().validatedTransports?.join(', ')}</span></Show><Show when={catalog().usage.find((item) => refKey(item.profileRef) === refKey(profileRefFromEntry(profile())))}>{(usage) => <span>Assigned routes: {usage().routes.join(', ')}</span>}</Show><For each={profile().limitations ?? []}>{(limitation) => <small>{limitation}</small>}</For></div>}</Show>
          <div class="admin-route-actions"><button type="button" class="admin-secondary-button" disabled={route.inventoryBusy || !gatewayRoutes().includes(route.name)} aria-label={`Inspect ${route.name} route`} onClick={() => void inspect(route.name)}>{route.inventoryBusy ? 'Inspecting…' : 'Inspect inventory'}</button><button type="button" class="admin-secondary-button" disabled={!gatewayRoutes().includes(route.name)} aria-label={`${route.inventory ? 'Revalidate' : 'Discover'} ${route.name} compatibility`} onClick={() => updateRoute(route.name, (item) => ({ ...item, discoveryOpen: !item.discoveryOpen }))}>{route.inventory ? 'Revalidate' : 'Discover'}</button></div>
          <Show when={!gatewayRoutes().includes(route.name)}><p class="admin-status-text">This stored route is no longer present in the gateway. Remove it or restore it in AI Gateway.</p></Show>
          <Show when={route.inventoryError}><div class="admin-inline-error" role="alert">{route.inventoryError}</div></Show>
          <Show when={inventoryLegs().length > 0}><section class="admin-inventory" aria-label={`${route.name} route inventory`}><p class="admin-status-text">AI Gateway selects conditional and fallback legs after request translation. Per-leg profiles record evidence; runtime uses the active route-wide profile above.</p><div class="admin-inventory-heading"><strong>Active route version</strong><span class="admin-mono">{route.assignment.routeVersion ?? 'Unavailable'}</span></div><div class="admin-leg-list"><For each={inventoryLegs()}>{(leg) => <div class="admin-leg-row"><div class="admin-leg-identity"><strong>{leg.nodeId}</strong><span>{leg.declaredModel}</span><small>{leg.provider}</small></div><label class="admin-form-field"><span>Per-leg evidence profile</span><select aria-label={`${leg.nodeId} evidence profile`} value={refKey(leg.profileRef)} onChange={(event) => setLeg(route.name, leg.nodeId, { profileRef: event.currentTarget.value ? profileRefFromEntry(assignableProfiles().find((profile) => refKey(profileRefFromEntry(profile)) === event.currentTarget.value)!) : undefined })}><option value="">No profile evidence</option><For each={assignableProfiles()}>{(profile) => <option value={refKey(profileRefFromEntry(profile))}>{profile.name} · revision {profile.revision}</option>}</For></select></label><Show when={leg.provider.toLowerCase().startsWith('custom')}><label class="admin-form-field"><span>Administrator-declared backend</span><input aria-label={`${leg.nodeId} custom provider backend`} value={leg.customProviderBackend ?? ''} onInput={(event) => setLeg(route.name, leg.nodeId, { customProviderBackend: event.currentTarget.value, evidence: { ...leg.evidence, current: false, status: 'stale' } })} /></label></Show><div class="admin-evidence-status"><span>Evidence</span><strong>{evidenceSummary(leg)}</strong></div></div>}</For></div><p class="admin-status-text">Common route levels: <strong>{commonLevels().join(', ') || 'None verified'}</strong></p><Show when={route.inventory?.warnings?.length}><ul class="admin-warning-list"><For each={route.inventory?.warnings}>{(warning) => <li>{warning}</li>}</For></ul></Show></section></Show>
          <Show when={route.discoveryOpen}><section class="admin-discovery" aria-label={`${route.name} discovery controls`}><h5>Bounded compatibility discovery</h5><p>At most 5 reasoning probes and 7 tool canaries run for this one target. REST is tried first; only a complete 404 permits one compat attempt per stage. Provider billing may differ.</p><div class="admin-add-row"><label class="admin-form-field"><span>Maximum completion tokens</span><input type="number" min="32" max="16384" value={route.discoveryCeiling ?? 32} onInput={(event) => updateRoute(route.name, (item) => ({ ...item, discoveryCeiling: Number(event.currentTarget.value) }))} /></label><button type="button" class="admin-primary-button" disabled={route.discoveryBusy} aria-label={`Start ${route.name} discovery`} onClick={() => void discover(route.name)}>{route.discoveryBusy ? 'Discovering…' : 'Start discovery'}</button></div><Show when={route.discoveryError}><div class="admin-inline-error" role="alert">{route.discoveryError}</div></Show><Show when={route.discoveryResult}>{(result) => <div class="admin-discovery-result" role="status"><strong>{result().classification}</strong><span>Logical probes: {result().accounting?.logicalProbes ?? 'Not reported'}</span><span>HTTP attempts: {result().accounting?.httpAttempts ?? 'Not reported'}</span><For each={result().warnings ?? []}>{(warning) => <small>{warning}</small>}</For><p>Discovery is non-activating. Review, save, assign, and Apply remain separate actions.</p><Show when={result().evidence && inventoryLegs().length === 1}><button type="button" class="admin-secondary-button" onClick={() => useDiscoveryEvidence(route.name)}>Use evidence in draft</button></Show></div>}</Show></section></Show>
          <Show when={pendingRemoval() === route.name}><div class="admin-confirmation" role="alert"><strong>{removalBlockReason(route.name) ? 'Route cannot be removed yet' : 'Confirm route removal'}</strong><p>{removalBlockReason(route.name) || (removalImpact(route.name).length ? `Affected references: ${removalImpact(route.name).join(', ')}. Defaults will move to the first remaining allowed route.` : 'This route has no default or group references.')}</p><div><button autofocus type="button" class="admin-secondary-button" onClick={() => setPendingRemoval(undefined)}>Keep route</button><Show when={!removalBlockReason(route.name)}><button type="button" class="admin-primary-button" aria-label={`Confirm remove ${route.name}`} onClick={() => confirmRemove(route.name)}>Confirm removal</button></Show></div></div></Show>
        </article>;
      }}</For></div>
    </section>

    <Show when={profileEditorOpen()}><ReasoningProfileEditor existingRevisions={customRevisions()} onCancel={() => setProfileEditorOpen(false)} onSave={(revision) => { setCustomRevisions((items) => [...items, revision]); setProfileEditorOpen(false); }} /></Show>
    <Show when={customRevisions().some((revision) => !catalog().profiles.some((profile) => profile.id === revision.id && profile.revision === revision.revision))}><p class="admin-status-text">Apply new custom revisions once to issue their canonical references; they become assignable from this catalog after Apply.</p></Show>

    <section class="admin-routing-section" aria-labelledby="notices-heading"><div class="admin-subsection-heading"><div><h3 id="notices-heading">Compatibility notices</h3><p>These families are read-only evidence and cannot be assigned.</p></div></div><Show when={catalog().notices.length > 0} fallback={<p class="admin-status-text">No compatibility notices reported.</p>}><div class="admin-notice-list"><For each={catalog().notices}>{(notice) => <article><strong>{notice.name}</strong><span class="admin-status">Not assignable</span><Show when={notice.summary}><p>{notice.summary}</p></Show><For each={notice.limitations ?? []}>{(limitation) => <small>{limitation}</small>}</For></article>}</For></div></Show></section>

    <section class="admin-routing-section" aria-labelledby="global-heading"><div class="admin-subsection-heading"><div><h3 id="global-heading">Global fallback defaults</h3><p>Used when no configured Access group matches.</p></div></div><div class="admin-profile-grid"><label class="admin-form-field"><span>Default route</span><select name="defaultRoute" aria-label="Global default route" value={defaultRoute()} onChange={(event) => { setDefaultRoute(event.currentTarget.value); const levels = supportedLevels(event.currentTarget.value); if (!levels.includes(defaultReasoning())) setDefaultReasoning(levels[0] ?? 'off'); }}><For each={routes()}>{(route) => <option value={route.name}>{route.name}</option>}</For></select></label><label class="admin-form-field"><span>Default reasoning</span><select name="reasoning" aria-label="Global default reasoning" value={defaultReasoning()} disabled={!defaultRoute() || supportedLevels(defaultRoute()).length === 0} onChange={(event) => setDefaultReasoning(event.currentTarget.value as PiReasoningLevel)}><For each={supportedLevels(defaultRoute())}>{(level) => <option value={level}>{level}</option>}</For></select></label></div></section>

    <section class="admin-routing-section" aria-labelledby="groups-heading">
      <div class="admin-subsection-heading">
        <div><h3 id="groups-heading">Group access and routing</h3><p>Routes are many-to-many. The first configured matching group wins.</p></div>
        <Show when={groups().length > 1}><div class="admin-heading-actions"><label class="admin-form-field"><span>Policy source</span><select value={applyGroupSource()} onChange={(event) => setApplyGroupSource(event.currentTarget.value)}><For each={groups()}>{(group) => <option value={group.accessGroup}>{group.accessGroup}</option>}</For></select></label><button type="button" class="admin-secondary-button" onClick={() => setApplyGroupsOpen(true)}>Apply to all groups</button></div></Show>
      </div>
      <Show when={unconfiguredGroups().length > 0}><div class="admin-add-row"><label class="admin-form-field"><span>Unconfigured access group</span><select aria-label="Unconfigured access group" value={groupToAdd()} onChange={(event) => setGroupToAdd(event.currentTarget.value)}><For each={unconfiguredGroups()}>{(group) => <option value={group}>{group}</option>}</For></select></label><button type="button" class="admin-secondary-button" onClick={addGroupPolicy}>Add group policy</button></div></Show>
      <div class="admin-group-list"><For each={groups()}>{(group) => <fieldset class="admin-group-card"><legend>{group.accessGroup}</legend><button type="button" class="admin-link-button admin-danger-link" aria-label={`Remove ${group.accessGroup} policy`} onClick={() => setGroups((items) => items.filter((item) => item.accessGroup !== group.accessGroup))}>Remove policy</button><fieldset class="admin-fieldset admin-group-routes" aria-label={`${group.accessGroup} allowed routes`}><legend>Allowed routes</legend><div class="admin-route-chip-list"><For each={routes()}>{(route) => <label class="admin-route-chip"><input type="checkbox" aria-label={`${group.accessGroup} ${route.name} route`} checked={group.routes.includes(route.name)} onChange={() => toggleGroupRoute(group.accessGroup, route.name)} /><span>{route.name}</span></label>}</For></div></fieldset><div class="admin-profile-grid"><label class="admin-form-field"><span>Default route</span><select aria-label={`${group.accessGroup} default route`} value={group.defaultRoute} disabled={group.routes.length === 0} onChange={(event) => setGroups((items) => items.map((item) => item.accessGroup === group.accessGroup ? { ...item, defaultRoute: event.currentTarget.value, reasoning: supportedLevels(event.currentTarget.value).includes(item.reasoning) ? item.reasoning : supportedLevels(event.currentTarget.value)[0] ?? 'off' } : item))}><For each={group.routes}>{(route) => <option value={route}>{route}</option>}</For></select></label><label class="admin-form-field"><span>Default reasoning</span><select aria-label={`${group.accessGroup} default reasoning`} value={group.reasoning} disabled={!group.defaultRoute || supportedLevels(group.defaultRoute).length === 0} onChange={(event) => setGroups((items) => items.map((item) => item.accessGroup === group.accessGroup ? { ...item, reasoning: event.currentTarget.value as PiReasoningLevel } : item))}><For each={supportedLevels(group.defaultRoute)}>{(level) => <option value={level}>{level}</option>}</For></select></label></div></fieldset>}</For></div>
      <Show when={applyGroupsOpen()}><div class="admin-confirmation" role="alert"><strong>Copy one group policy</strong><p>{applyGroupSource()} will be copied to every affected group: {groups().map((group) => group.accessGroup).join(', ')}.</p><div><button autofocus type="button" class="admin-secondary-button" onClick={() => setApplyGroupsOpen(false)}>Cancel</button><button type="button" class="admin-primary-button" onClick={copyGroupToAll}>Confirm group changes</button></div></div></Show>
    </section>

    <For each={routes()}>{(route) => <input type="hidden" name="dynamicRoutes" value={route.name} />}</For>
    <input type="hidden" name="groupRouting" value={JSON.stringify(groups())} />
    <input type="hidden" name="reasoningConfiguration" value={JSON.stringify(serializedConfiguration())} />
  </div>;
};

export default AiRoutingFields;
/* v8 ignore stop */
