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
  verificationBusy?: boolean;
  verificationResult?: ReasoningDiscoveryResult;
  verificationError?: string;
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
    ...(candidate.commonMapping !== undefined ? { commonMapping: candidate.commonMapping as ReasoningRouteAssignment['commonMapping'] } : {}),
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
function compatibilitySummary(leg: ReasoningRouteLeg): string {
  if (leg.evidence?.status === 'stale' || leg.evidence?.current === false) return 'Needs another check';
  if (leg.evidence?.toolReplay === true) return 'Checked';
  return 'Not checked';
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
  const [profileEditorRoute, setProfileEditorRoute] = createSignal<string>();
  const [pendingProfileName, setPendingProfileName] = createSignal('');

  onMount(async () => {
    try {
      const loaded = await getReasoningCatalog();
      setCatalog(loaded);
      if (loaded.routeCatalogStatus === 'ready') {
        setGatewayRoutes(loaded.routes);
        setRoutes((items) => {
          const byName = new Map(items.map((route) => [route.name, route]));
          const discovered = loaded.routes.map((name) => {
            const existing = byName.get(name);
            return existing ? { ...existing } : { name, contextWindow: DEFAULT_CONTEXT_WINDOW, assignment: {} };
          });
          return [...discovered, ...items.filter((route) => !loaded.routes.includes(route.name)).map((route) => ({ ...route }))];
        });
        if (!defaultRoute() && loaded.routes[0]) setDefaultRoute(loaded.routes[0]);
      }
    } catch (reason) {
      setCatalogError(reason instanceof Error ? reason.message : 'Reasoning profile catalog could not be loaded.');
    } finally {
      setCatalogBusy(false);
    }
  });

  const assignableProfiles = createMemo(() => catalog().profiles.filter((profile) => profile.enabled !== false && profile.assignable !== false));
  const pendingDraftNames = createMemo(() => customRevisions()
    .filter((revision) => !catalog().profiles.some((profile) => profile.id === revision.id && profile.revision === revision.revision))
    .map((revision) => String(revision.name ?? revision.id ?? 'New profile')));
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

  const verifySelectedProfile = async (name: string) => {
    const route = routeByName(name);
    if (!route?.assignment.activeProfile) {
      updateRoute(name, (item) => ({ ...item, verificationError: 'Select a reasoning profile before verification.' }));
      return;
    }
    updateRoute(name, (item) => ({ ...item, verificationBusy: true, verificationResult: undefined, verificationError: undefined }));
    try {
      const result = await discoverReasoningCompatibility({ route: name, profileRef: route.assignment.activeProfile, maxCompletionTokens: 32 });
      updateRoute(name, (item) => ({ ...item, verificationBusy: false, verificationResult: result }));
    } catch (reason) {
      updateRoute(name, (item) => ({ ...item, verificationBusy: false, verificationError: reason instanceof Error ? reason.message : 'Profile verification failed.' }));
    }
  };

  const attachCompatibilityRecord = (name: string) => {
    const route = routeByName(name);
    const evidence = route?.verificationResult?.evidence;
    const legs = route?.assignment.legs ?? [];
    if (!route || !evidence || legs.length !== 1 || !route.assignment.activeProfile) {
      updateRoute(name, (item) => ({ ...item, verificationError: 'Refresh gateway details first. A record can be attached only when the route has one reachable leg.' }));
      return;
    }
    updateRoute(name, (item) => ({
      ...item,
      verificationError: undefined,
      assignment: {
        ...item.assignment,
        commonMapping: undefined,
        legs: legs.map((leg) => ({ ...leg, profileRef: item.assignment.activeProfile, evidence: { ...evidence } })),
      },
    }));
  };

  const setLeg = (routeName: string, nodeId: string, patch: Partial<ReasoningRouteLeg>) => updateRoute(routeName, (route) => ({
    ...route,
    assignment: { ...route.assignment, legs: (route.assignment.legs ?? []).map((leg) => leg.nodeId === nodeId ? { ...leg, ...patch } : leg) },
  }));

  const serializedConfiguration = createMemo<ReasoningConfiguration>(() => ({
    schemaVersion: 1,
    customProfileRevisions: customRevisions(),
    routeAssignments: Object.fromEntries(routes().flatMap((route) => route.assignment.activeProfile ? [[route.name, {
      ...route.assignment,
      activeProfile: route.assignment.activeProfile,
    } satisfies ReasoningRouteAssignment]] : [])),
  }));

  return <div class="admin-ai-routing admin-form-wide">
    <div class="admin-routing-guide">
      <strong>Configure each route in one place</strong>
      <span>Choose its reasoning profile, check compatibility, then Review and Apply your changes.</span>
    </div>

    <details class="admin-routing-section admin-routing-disclosure" open={!text(current.gatewayUrl) || current.tokenState === 'none'}>
      <summary><span><strong>AI Gateway connection</strong><small>{text(current.gatewayUrl) && current.tokenState !== 'none' ? 'Configured' : 'Action required'}</small></span><span>Connection settings</span></summary>
      <div class="admin-profile-grid admin-disclosure-content">
        <label class="admin-form-field"><span>AI Gateway URL</span><input name="gatewayUrl" type="url" value={text(current.gatewayUrl)} /></label>
        <label class="admin-form-field"><span>Replacement API token</span><input name="replacementToken" type="password" value="" autocomplete="new-password" /></label>
        <div class="admin-readonly-field"><span>Credential source</span><strong>{current.tokenState === 'administration' ? 'Saved in Administration' : current.tokenState === 'deployment' ? 'Deployment fallback' : 'Token required'}</strong><small>Blank replacement fields keep the current encrypted token.</small></div>
      </div>
    </details>

    <section class="admin-routing-section" aria-labelledby="catalog-heading">
      <div class="admin-subsection-heading"><div><p class="admin-step-label">Route configuration</p><h3 id="catalog-heading">AI Gateway routes</h3><p>Routes come from AI Gateway. Codeflare applies one reasoning profile before the gateway privately selects a backend.</p></div></div>
      <Show when={catalogBusy()}><p class="admin-status-text" role="status">Loading reasoning profiles…</p></Show>
      <Show when={catalogError()}><div class="admin-inline-error" role="alert">{catalogError()}</div></Show>
      <Show when={!catalogBusy() && catalog().routeCatalogStatus === 'unavailable'}><div class="admin-inline-error" role="alert">Dynamic routes could not be read with the saved AI Gateway connection. Verify the URL and that the saved token includes AI Gateway Read.</div></Show>

      <div class="admin-route-list"><For each={routes()}>{(route) => {
        const selectedProfile = () => findProfile(route.assignment.activeProfile);
        const inventoryLegs = () => route.assignment.legs ?? [];
        const commonLevels = () => route.assignment.commonMapping
          ? LEVELS.filter((level) => route.assignment.commonMapping?.levels[level])
          : route.inventory?.commonLevels ?? [];
        return <article class="admin-route-card">
          <div class="admin-route-card-heading"><div><h4>{route.name}</h4><span class="admin-route-presence">{gatewayRoutes().includes(route.name) ? 'Gateway route' : 'Missing from gateway'}</span></div><Show when={!gatewayRoutes().includes(route.name)}><button type="button" class="admin-link-button admin-danger-link" aria-label={`Remove ${route.name} stale route`} onClick={() => setPendingRemoval(route.name)}>Remove stale route</button></Show></div>
          <div class="admin-route-controls">
            <label class="admin-form-field"><span>Context window</span><input name="routeContextWindow" type="number" min="1" step="1" aria-label={`${route.name} context window`} value={route.contextWindow} onInput={(event) => updateRoute(route.name, (item) => ({ ...item, contextWindow: Number(event.currentTarget.value) }))} /></label>
            <input type="hidden" name="routeContextRoute" value={route.name} />
            <label class="admin-form-field"><span>Reasoning profile</span><select aria-label={`${route.name} reasoning profile`} value={refKey(route.assignment.activeProfile)} disabled={catalogBusy() || Boolean(catalogError())} onChange={(event) => setRouteProfile(route.name, event.currentTarget.value)}><option value="">Select reasoning profile</option><For each={assignableProfiles()}>{(profile) => <option value={refKey(profileRefFromEntry(profile))}>{profile.name} · revision {profile.revision}</option>}</For></select></label>
          </div>
          <Show when={selectedProfile()}>{(profile) => <div class="admin-route-profile"><span>Selected profile</span><strong>{profile().name}</strong><small>{profile().supportedLevels.length} reasoning levels available</small></div>}</Show>
          <Show when={gatewayRoutes().includes(route.name)}><button type="button" class="admin-primary-button admin-route-discover" aria-label={`Discover ${route.name} compatibility`} onClick={() => setProfileEditorRoute(route.name)}>Discover compatibility</button></Show>
          <Show when={profileEditorRoute() === route.name}><ReasoningProfileEditor route={route.name} existingRevisions={customRevisions()} onCancel={() => setProfileEditorRoute(undefined)} onSave={(revision) => { setCustomRevisions((items) => [...items, revision]); setPendingProfileName(String(revision.name ?? 'New profile')); setProfileEditorRoute(undefined); }} /></Show>
          <details class="admin-route-details"><summary>Advanced route details</summary><div class="admin-route-details-content"><Show when={selectedProfile()}>{(profile) => <div class="admin-profile-summary"><strong>Profile behavior</strong><span>Supported levels: {profile().supportedLevels.join(', ')}</span><span>{offSummary(profile())}</span><span>Pi tools: {profile().toolCompatibility?.status ?? 'Not checked'}</span><Show when={profile().validatedTransports?.length}><span>Validated transport: {profile().validatedTransports?.join(', ')}</span></Show><Show when={catalog().usage.find((item) => refKey(item.profileRef) === refKey(profileRefFromEntry(profile())))}>{(usage) => <span>Assigned routes: {usage().routes.join(', ')}</span>}</Show><For each={profile().limitations ?? []}>{(limitation) => <small>{limitation}</small>}</For></div>}</Show><p class="admin-status-text">Gateway legs and compatibility records are diagnostic only. They document observed behavior and never choose a backend or alter runtime.</p><div class="admin-route-actions"><button type="button" class="admin-secondary-button" disabled={route.inventoryBusy || !gatewayRoutes().includes(route.name)} aria-label={`Refresh ${route.name} gateway details`} onClick={() => void inspect(route.name)}>{route.inventoryBusy ? 'Refreshing…' : 'Refresh gateway details'}</button><button type="button" class="admin-secondary-button" disabled={route.verificationBusy || !route.assignment.activeProfile || !gatewayRoutes().includes(route.name)} aria-label={`Verify ${route.name} selected profile`} onClick={() => void verifySelectedProfile(route.name)}>{route.verificationBusy ? 'Verifying…' : 'Verify selected profile'}</button></div><Show when={route.verificationError}><div class="admin-inline-error" role="alert">{route.verificationError}</div></Show><Show when={route.verificationResult}>{(result) => <div class="admin-discovery-result" role="status"><strong>Selected profile check: {result().classification}</strong><span>Logical probes: {result().accounting?.logicalProbes ?? 'Not reported'}</span><span>HTTP attempts: {result().accounting?.httpAttempts ?? 'Not reported'}</span><For each={result().warnings ?? []}>{(warning) => <small>{warning}</small>}</For><Show when={result().assignable === true && result().evidence && inventoryLegs().length === 1}><button type="button" class="admin-secondary-button" onClick={() => attachCompatibilityRecord(route.name)}>Add compatibility record</button></Show></div>}</Show>
          <Show when={!gatewayRoutes().includes(route.name)}><p class="admin-status-text">This stored route is no longer present in the gateway. Remove it or restore it in AI Gateway.</p></Show>
          <Show when={route.inventoryError}><div class="admin-inline-error" role="alert">{route.inventoryError}</div></Show>
          <Show when={inventoryLegs().length > 0}><section class="admin-inventory" aria-label={`${route.name} route inventory`}><p class="admin-status-text">AI Gateway privately selects conditional and fallback legs after Codeflare applies the route-wide profile.</p><div class="admin-inventory-heading"><strong>Active route version</strong><span class="admin-mono">{route.assignment.routeVersion ?? 'Unavailable'}</span></div><div class="admin-leg-list"><For each={inventoryLegs()}>{(leg) => <div class="admin-leg-row"><div class="admin-leg-identity"><strong>{leg.nodeId}</strong><span>{leg.declaredModel}</span><small>{leg.provider}</small></div><label class="admin-form-field"><span>Compatibility record</span><select aria-label={`${leg.nodeId} compatibility record`} value={refKey(leg.profileRef)} onChange={(event) => setLeg(route.name, leg.nodeId, { profileRef: event.currentTarget.value ? profileRefFromEntry(assignableProfiles().find((profile) => refKey(profileRefFromEntry(profile)) === event.currentTarget.value)!) : undefined })}><option value="">No compatibility record</option><For each={assignableProfiles()}>{(profile) => <option value={refKey(profileRefFromEntry(profile))}>{profile.name} · revision {profile.revision}</option>}</For></select></label><Show when={leg.provider.toLowerCase().startsWith('custom')}><label class="admin-form-field"><span>Administrator-declared backend</span><input aria-label={`${leg.nodeId} custom provider backend`} value={leg.customProviderBackend ?? ''} onInput={(event) => setLeg(route.name, leg.nodeId, { customProviderBackend: event.currentTarget.value, evidence: { ...leg.evidence, current: false, status: 'stale' } })} /></label></Show><div class="admin-evidence-status"><span>Compatibility</span><strong>{compatibilitySummary(leg)}</strong></div></div>}</For></div><p class="admin-status-text">Shared supported levels: <strong>{commonLevels().join(', ') || 'None checked'}</strong></p><Show when={route.inventory?.warnings?.length}><ul class="admin-warning-list"><For each={route.inventory?.warnings}>{(warning) => <li>{warning}</li>}</For></ul></Show></section></Show>
          </div></details>
          <Show when={pendingRemoval() === route.name}><div class="admin-confirmation" role="alert"><strong>{removalBlockReason(route.name) ? 'Route cannot be removed yet' : 'Confirm route removal'}</strong><p>{removalBlockReason(route.name) || (removalImpact(route.name).length ? `Affected references: ${removalImpact(route.name).join(', ')}. Defaults will move to the first remaining allowed route.` : 'This route has no default or group references.')}</p><div><button autofocus type="button" class="admin-secondary-button" onClick={() => setPendingRemoval(undefined)}>Keep route</button><Show when={!removalBlockReason(route.name)}><button type="button" class="admin-primary-button" aria-label={`Confirm remove ${route.name}`} onClick={() => confirmRemove(route.name)}>Confirm removal</button></Show></div></div></Show>
        </article>;
      }}</For></div>
    </section>

    <Show when={!catalogBusy() && (pendingProfileName() || pendingDraftNames()[0])}>{(profileName) => <div class="admin-unsaved-banner" role="status"><div><strong>{profileName()} is ready to review</strong><span>This draft is not saved, assigned, or active yet. Continue to Review, then confirm Apply change.</span></div><button type="submit" class="admin-primary-button">Review and save profile</button></div>}</Show>

    <details class="admin-routing-section admin-routing-disclosure"><summary><span><strong>Known compatibility limitations</strong><small>{catalog().notices.length} non-assignable records</small></span><span>Advanced information</span></summary><div class="admin-notice-list admin-disclosure-content"><Show when={catalog().notices.length > 0} fallback={<p class="admin-status-text">No compatibility limitations reported.</p>}><For each={catalog().notices}>{(notice) => <article><strong>{notice.name}</strong><span class="admin-status">Not assignable</span><Show when={notice.summary}><p>{notice.summary}</p></Show><For each={notice.limitations ?? []}>{(limitation) => <small>{limitation}</small>}</For></article>}</For></Show></div></details>

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
