/* v8 ignore start -- user-validated administration UI */
import { For, Show, createMemo, createSignal, onCleanup, onMount, type Component } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
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
import ReasoningProfileEditor, { DISCOVERY_COMPLETION_TOKENS, ReasoningCheckDetails, ReasoningCheckOverview, reasoningCheckSummary } from './ReasoningProfileEditor';

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
}
interface VerificationDraft {
  busy?: boolean;
  result?: ReasoningDiscoveryResult;
  error?: string;
  routeChanged?: boolean;
}

function inventoryVersion(inventory?: ReasoningRouteInventory): string | undefined {
  return inventory?.routeVersion ?? inventory?.versionId;
}
function legIdentity(leg: ReasoningRouteLeg): string {
  return JSON.stringify([leg.nodeId, leg.provider, leg.declaredModel, leg.customProviderBackend ?? '']);
}
function inventoryIdentity(inventory: ReasoningRouteInventory): string {
  return JSON.stringify([inventoryVersion(inventory), inventory.legs.map(legIdentity).sort()]);
}
function completeEvidence(evidence: ReasoningRouteLeg['evidence']): boolean {
  return evidence?.current === true && evidence.toolReplay === true
    && evidence.ingress === 'ai-gateway-chat-completions'
    && evidence.status === 'Verified';
}
function completeVerification(result: ReasoningDiscoveryResult): boolean {
  return result.assignable === true && result.classification === 'Verified'
    && completeEvidence(result.evidence) && !(result.diagnostics?.length)
    && !result.candidateResults?.some((candidate) => candidate.diagnostics?.length);
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

const AiRoutingFields: Component<Props> = (props) => {
  const current = record(props.current);
  const configuration = record(current.reasoningConfiguration);
  const assignments = record(configuration.routeAssignments);
  const contextWindows = record(current.routeContextWindows);
  const configuredRoutes = stringList(current.dynamicRoutes);
  const [gatewayRoutes, setGatewayRoutes] = createSignal<string[]>([]);
  const [routeState, setRouteState] = createStore<RouteDraft[]>(configuredRoutes.map((name) => ({
    name,
    contextWindow: typeof contextWindows[name] === 'number' ? contextWindows[name] as number : DEFAULT_CONTEXT_WINDOW,
    assignment: routeAssignment(assignments[name]),
  })));
  const routes = () => routeState;
  const setRoutes = (update: (items: RouteDraft[]) => RouteDraft[]) => setRouteState(reconcile(update(routeState), { key: 'name' }));
  const storedDefault = record(current.defaultRoute);
  const [defaultRoute, setDefaultRoute] = createSignal(text(storedDefault.route));
  const [defaultReasoning, setDefaultReasoning] = createSignal<PiReasoningLevel>(isLevel(storedDefault.reasoning) ? storedDefault.reasoning : 'off');
  const availableAccessGroups = stringList(current.availableAccessGroups);
  const [groups, setGroups] = createSignal<GroupDraft[]>(groupDrafts(current.groupRouting));
  const isRoutingRoute = (route: RouteDraft): boolean => configuredRoutes.includes(route.name)
    || Boolean(route.assignment.activeProfile)
    || defaultRoute() === route.name
    || groups().some((group) => group.defaultRoute === route.name || group.routes.includes(route.name));
  const routingRoutes = createMemo(() => routes().filter(isRoutingRoute));
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
  const [verifications, setVerifications] = createSignal<Record<string, VerificationDraft>>({});
  const verificationFor = (name: string): VerificationDraft => verifications()[name] ?? {};
  const updateVerification = (name: string, update: (draft: VerificationDraft) => VerificationDraft) => setVerifications((items) => ({ ...items, [name]: update(items[name] ?? {}) }));
  let disposed = false;
  onCleanup(() => { disposed = true; });

  onMount(async () => {
    try {
      const loaded = await getReasoningCatalog();
      if (disposed) return;
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
        if (!defaultRoute() && routingRoutes()[0]) setDefaultRoute(routingRoutes()[0].name);
      }
    } catch (reason) {
      setCatalogError(reason instanceof Error ? reason.message : 'Reasoning profile catalog could not be loaded.');
    } finally {
      if (!disposed) setCatalogBusy(false);
    }
    // Management reads only: show models without starting paid compatibility checks.
    for (const name of gatewayRoutes()) {
      if (disposed) break;
      await inspect(name);
    }
  });

  const assignableProfiles = createMemo(() => [
    ...catalog().profiles,
    ...customRevisions().filter((revision) => !catalog().profiles.some((profile) => profile.id === revision.id && profile.revision === revision.revision))
      .flatMap((revision): ReasoningProfileCatalogEntry[] => {
        const ref = profileRef(revision);
        return ref ? [{ ...revision, ...ref, name: text(revision.name), enabled: revision.enabled !== false, supportedLevels: stringList(revision.supportedLevels).filter(isLevel), classification: text(revision.classification) }] : [];
      }),
  ].filter((profile) => profile.enabled !== false && profile.assignable !== false));
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
    updateVerification(name, () => ({}));
    updateRoute(name, (route) => ({
      ...route,
      assignment: {
        ...route.assignment,
        ...(selectedRef ? { activeProfile: selectedRef } : { activeProfile: undefined }),
        commonMapping: undefined,
        ...(route.assignment.legs && { legs: route.assignment.legs.map((leg) => ({
          ...leg,
          ...(selectedRef && { profileRef: selectedRef }),
          ...(leg.evidence && { evidence: { ...leg.evidence, current: false, status: 'stale' } }),
        })) }),
      },
    }));
    if (!defaultRoute() && selectedRef) setDefaultRoute(name);
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
    if (routingRoutes().length === 1 && routingRoutes()[0].name === name) return 'At least one route must remain in the catalog.';
    const emptyGroups = groups().filter((group) => group.routes.length === 1 && group.routes[0] === name).map((group) => group.accessGroup);
    return emptyGroups.length > 0 ? `Add another allowed route to ${emptyGroups.join(', ')} before removing this route.` : '';
  };

  const confirmRemove = (name: string) => {
    const remaining = routes().filter((route) => route.name !== name);
    setRoutes(() => remaining);
    const replacement = routingRoutes()[0]?.name ?? '';
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
    const selectedRoutes = routingRoutes().map((route) => route.name);
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

  const inspect = async (name: string): Promise<ReasoningRouteInventory | undefined> => {
    updateRoute(name, (route) => ({ ...route, inventoryBusy: true, inventoryError: undefined }));
    try {
      const inventory = await getReasoningRouteInventory(name);
      if (disposed) return;
      updateRoute(name, (route) => ({ ...route, inventory, inventoryBusy: false }));
      return inventory;
    } catch {
      if (!disposed) updateRoute(name, (route) => ({ ...route, inventory: undefined, inventoryBusy: false, inventoryError: 'Gateway models could not be loaded. Refresh models to try again.' }));
      return undefined;
    }
  };

  const savedProfile = (route: RouteDraft): boolean => catalog().profiles.some((profile) =>
    refKey(profileRefFromEntry(profile)) === refKey(route.assignment.activeProfile));
  const pendingBackend = (route: RouteDraft): boolean => (route.assignment.legs ?? []).some((leg) =>
    leg.provider.toLowerCase().startsWith('custom') && route.inventory?.legs.some((live) =>
      live.nodeId === leg.nodeId && (live.customProviderBackend ?? '') !== (leg.customProviderBackend ?? '')));
  const verifiedAssignment = (route: RouteDraft): boolean => {
    const inventory = route.inventory;
    const leg = route.assignment.legs?.[0];
    return Boolean(findProfile(route.assignment.activeProfile) && inventory && !route.inventoryBusy && !route.inventoryError
      && inventoryVersion(inventory) && route.assignment.routeVersion === inventoryVersion(inventory)
      && inventory.legs.length === 1 && route.assignment.legs?.length === 1 && leg
      && legIdentity(leg) === legIdentity(inventory.legs[0])
      && refKey(leg.profileRef) === refKey(route.assignment.activeProfile) && completeEvidence(leg.evidence));
  };
  const routeStatus = (route: RouteDraft): { label: string; state: 'passed' | 'failed' | 'unclear' } => {
    const check = verificationFor(route.name);
    if (!route.assignment.activeProfile) return { label: 'No profile assigned', state: 'unclear' };
    if (check.busy) return { label: 'Verifying…', state: 'unclear' };
    if (check.routeChanged) return { label: 'Needs verification', state: 'unclear' };
    if (check.error) return { label: 'Verification failed', state: 'failed' };
    if (check.result && !completeVerification(check.result)) {
      const failed = check.result.classification === 'Unsupported' || check.result.outcome === 'unsupported';
      return { label: failed ? 'Verification failed' : 'Verification unclear', state: failed ? 'failed' : 'unclear' };
    }
    if (verifiedAssignment(route)) return { label: 'Profile verified', state: 'passed' };
    if (check.result && completeVerification(check.result) && (route.inventory?.legs.length ?? 0) > 1) {
      return { label: 'Observed path passed', state: 'unclear' };
    }
    return { label: 'Needs verification', state: 'unclear' };
  };

  const verifySelectedProfile = async (name: string) => {
    const route = routeByName(name);
    if (!route?.assignment.activeProfile || !savedProfile(route) || pendingBackend(route) || verificationFor(name).busy) return;
    const selectedRef = { ...route.assignment.activeProfile };
    updateVerification(name, () => ({ busy: true }));
    if (route.assignment.legs?.some((leg) => leg.evidence?.current === true)) {
      updateRoute(name, (item) => ({ ...item, assignment: { ...item.assignment, commonMapping: undefined,
        legs: item.assignment.legs?.map((leg) => ({ ...leg, ...(leg.evidence && { evidence: { ...leg.evidence, current: false, status: 'stale' } }) })),
      } }));
    }
    try {
      const before = await inspect(name);
      if (!before || !inventoryVersion(before)) {
        if (!disposed) updateVerification(name, () => ({ error: 'Load the current gateway models before verifying this profile.' }));
        return;
      }
      const result = await discoverReasoningCompatibility({ route: name, profileRef: selectedRef, maxCompletionTokens: DISCOVERY_COMPLETION_TOKENS });
      if (disposed) return;
      const after = await inspect(name);
      const currentRoute = routeByName(name);
      if (disposed || !currentRoute || refKey(currentRoute.assignment.activeProfile) !== refKey(selectedRef)) return;
      const changed = !after || inventoryIdentity(before) !== inventoryIdentity(after);
      updateVerification(name, () => ({ result, routeChanged: changed }));
      if (!changed && after && after.legs.length === 1 && completeVerification(result)) {
        const leg = after.legs[0];
        updateRoute(name, (item) => ({
          ...item,
          assignment: {
            ...item.assignment,
            routeVersion: inventoryVersion(after),
            commonMapping: undefined,
            legs: [{
              nodeId: leg.nodeId, provider: leg.provider, declaredModel: leg.declaredModel,
              ...(leg.customProviderBackend && { customProviderBackend: leg.customProviderBackend }),
              profileRef: selectedRef, evidence: { ...result.evidence },
            }],
          },
        }));
      }
    } catch {
      if (!disposed) updateVerification(name, () => ({ error: 'Profile verification failed. Check the saved AI Gateway connection and try again.' }));
    }
  };

  const setLegBackend = (routeName: string, nodeId: string, backend: string) => {
    updateVerification(routeName, () => ({}));
    updateRoute(routeName, (route) => ({
      ...route,
      assignment: {
        ...route.assignment, commonMapping: undefined,
        legs: (route.inventory?.legs ?? route.assignment.legs ?? []).map((leg) => ({
          nodeId: leg.nodeId, provider: leg.provider, declaredModel: leg.declaredModel,
          ...(leg.customProviderBackend && { customProviderBackend: leg.customProviderBackend }),
          profileRef: route.assignment.activeProfile,
          ...(leg.nodeId === nodeId && { customProviderBackend: backend }),
          evidence: { current: false, status: 'stale' },
        })),
      },
    }));
  };

  const reasoningDisabled = (name: string): boolean => catalogBusy() || supportedLevels(name).length <= 1;
  const reasoningHelp = (name: string): string => {
    if (catalogBusy()) return 'Loading profile options…';
    if (catalogError()) return 'Profile options are unavailable. Reload the configuration to try again.';
    if (!name) return 'Choose a default route first.';
    const profile = findProfile(routeByName(name)?.assignment.activeProfile);
    if (!profile) return `Assign a reasoning profile to ${name} to choose its default reasoning.`;
    if (profile.supportedLevels.length === 1) return `${profile.name} supports only ${profile.supportedLevels[0]}. No other default is available.`;
    return `Options come from the ${profile.name} profile assigned to ${name}.${profile.supportedLevels.includes('off') ? '' : ' Off is not supported by this profile.'} Verification is not required to choose a default.`;
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
    <div class="admin-routing-guide">
      <strong>Configure each route in one place</strong>
      <span id="routing-checks-help">Assign a profile and Save. Map finds compatible profiles; Verify checks your selection. Checks may use provider credits and do not save changes.</span>
    </div>

    <details class="admin-routing-section admin-routing-disclosure" open={!text(current.gatewayUrl) || current.tokenState === 'none'}>
      <summary><span><strong>AI Gateway connection</strong><small>{text(current.gatewayUrl) && current.tokenState !== 'none' ? 'Configured' : 'Action required'}</small></span><span>Connection settings</span></summary>
      <div class="admin-profile-grid admin-disclosure-content">
        <label class="admin-form-field"><span>AI Gateway URL</span><input name="gatewayUrl" type="url" value={text(current.gatewayUrl)} /></label>
        <label class="admin-form-field"><span>Replacement API token</span><input name="replacementToken" type="password" value="" autocomplete="new-password" /></label>
        <div class="admin-readonly-field"><span>Credential source</span><strong>{current.tokenState === 'administration' ? 'Saved in Administration' : current.tokenState === 'deployment' ? 'Deployment fallback' : 'Token required'}</strong><small>Blank replacement fields keep the current encrypted token.</small></div>
      </div>
    </details>

    <section class="admin-routing-section admin-routes-section" aria-labelledby="catalog-heading">
      <div class="admin-subsection-heading"><div><p class="admin-step-label">Route configuration</p><h3 id="catalog-heading">AI Gateway routes</h3><p>Routes come from AI Gateway. Codeflare applies one reasoning profile before the gateway privately selects a backend.</p></div></div>
      <Show when={catalogBusy()}><p class="admin-status-text" role="status">Loading reasoning profiles…</p></Show>
      <Show when={catalogError()}><div class="admin-inline-error" role="alert">{catalogError()}</div></Show>
      <Show when={!catalogBusy() && catalog().routeCatalogStatus === 'unavailable'}><div class="admin-inline-error" role="alert">Dynamic routes could not be read with the saved AI Gateway connection. Verify the URL and that the saved token includes AI Gateway Read.</div></Show>

      <div class="admin-route-list"><For each={routes()}>{(route) => {
        const selectedProfile = () => findProfile(route.assignment.activeProfile);
        const verification = () => verificationFor(route.name);
        const inventoryLegs = () => route.inventory?.legs ?? route.assignment.legs ?? [];
        return <article class="admin-route-card" aria-label={`${route.name} route`}>
          <div class="admin-route-card-heading">
            <div><h4>{route.name}</h4><span class="admin-check-pill" data-state={routeStatus(route).state} role="status">{routeStatus(route).label}</span></div>
            <Show when={!gatewayRoutes().includes(route.name)}><button type="button" class="admin-link-button admin-danger-link" aria-label={`Remove ${route.name} stale route`} onClick={() => setPendingRemoval(route.name)}>Remove stale route</button></Show>
          </div>
          <section class="admin-route-models" aria-label={`${route.name} detected models`}>
            <div class="admin-model-heading"><strong>Detected models</strong><Show when={gatewayRoutes().includes(route.name)}><button type="button" class="admin-link-button" aria-label={`Refresh ${route.name} models`} disabled={route.inventoryBusy || verification().busy} onClick={() => void inspect(route.name)}>Refresh models</button></Show></div>
            <Show when={route.inventoryBusy}><p class="admin-status-text">Loading models…</p></Show>
            <Show when={route.inventoryError}><p class="admin-inline-error" role="alert">{route.inventoryError}</p></Show>
            <ul class="admin-model-list"><For each={inventoryLegs()}>{(leg) => <li>
              <strong>{leg.declaredModel}</strong><span>{leg.provider}</span><small>{leg.nodeId}</small>
            </li>}</For></ul>
            <Show when={!route.inventoryBusy && !route.inventoryError && inventoryLegs().length === 0}><p class="admin-status-text">No model inventory available.</p></Show>
            <Show when={inventoryLegs().length > 1}><p class="admin-status-text">This route has conditional or fallback models. A check covers the path the gateway selects, not every backend.</p></Show>
          </section>
          <div class="admin-route-controls">
            <label class="admin-form-field"><span>Reasoning profile</span><select aria-label={`${route.name} reasoning profile`} value={refKey(route.assignment.activeProfile)} disabled={catalogBusy() || Boolean(catalogError()) || verification().busy || profileEditorRoute() === route.name} onChange={(event) => setRouteProfile(route.name, event.currentTarget.value)}><option value="" selected={!route.assignment.activeProfile}>Select reasoning profile</option><For each={assignableProfiles()}>{(profile) => <option value={refKey(profileRefFromEntry(profile))} selected={refKey(profileRefFromEntry(profile)) === refKey(route.assignment.activeProfile)}>{profile.name} · revision {profile.revision}</option>}</For></select></label>
            <label class="admin-form-field"><span>Context window</span><input name={isRoutingRoute(route) ? 'routeContextWindow' : undefined} type={isRoutingRoute(route) ? 'number' : 'text'} inputmode="numeric" min={isRoutingRoute(route) ? 1 : undefined} step={isRoutingRoute(route) ? 1 : 'any'} required={isRoutingRoute(route)} aria-label={`${route.name} context window`} value={route.contextWindow} onInput={(event) => updateRoute(route.name, (item) => ({ ...item, contextWindow: Number(event.currentTarget.value) }))} /></label>
            <input type="hidden" name={isRoutingRoute(route) ? 'routeContextRoute' : undefined} value={route.name} />
          </div>
          <div class="admin-route-actions">
            <Show when={gatewayRoutes().includes(route.name)}><button type="button" class="admin-secondary-button" aria-label={`Map Profile for ${route.name}`} aria-describedby="routing-checks-help" disabled={verification().busy || profileEditorRoute() === route.name} onClick={() => setProfileEditorRoute(route.name)}>Map Profile</button></Show>
            <Show when={route.assignment.activeProfile && gatewayRoutes().includes(route.name)}><button type="button" class="admin-secondary-button" aria-label={`Verify Profile for ${route.name}`} aria-describedby="routing-checks-help" disabled={verification().busy || route.inventoryBusy || !savedProfile(route) || pendingBackend(route) || profileEditorRoute() === route.name} onClick={() => void verifySelectedProfile(route.name)}>{verification().busy ? 'Verifying…' : 'Verify Profile'}</button></Show>
          </div>
          <Show when={selectedProfile() && !savedProfile(route)}><p class="admin-status-text">Save this new profile before verifying.</p></Show>
          <Show when={pendingBackend(route)}><p class="admin-status-text">Save the backend description before verifying.</p></Show>
          <Show when={verification().error}><p class="admin-inline-error" role="alert">{verification().error}</p></Show>
          <Show when={verification().routeChanged}><p class="admin-status-text">Gateway models changed during the check, or could not be refreshed. Verify again before relying on this result.</p></Show>
          <Show when={verification().result}>{(result) => <section class="admin-route-verification" aria-label={`${route.name} profile verification`}>
            <ReasoningCheckOverview result={result()} levels={selectedProfile()?.supportedLevels ?? []} />
            <Show when={!completeVerification(result())}><p class="admin-status-text">{reasoningCheckSummary(result())}</p></Show>
            <Show when={routeStatus(route).state === 'passed'}><p class="admin-status-text">Verification added to the route draft. Save to keep it.</p></Show>
            <ReasoningCheckDetails result={result()} />
          </section>}</Show>
          <Show when={profileEditorRoute() === route.name}><ReasoningProfileEditor route={route.name} existingRevisions={customRevisions()} onCancel={() => setProfileEditorRoute(undefined)} onSelectProfile={(ref) => { setProfileEditorRoute(undefined); setRouteProfile(route.name, refKey(ref)); }} onSave={(revision) => { setProfileEditorRoute(undefined); setCustomRevisions((items) => [...items, revision]); setRouteProfile(route.name, refKey(profileRef(revision))); setPendingProfileName(String(revision.name ?? 'New profile')); }} /></Show>
          <details class="admin-route-details"><summary>Profile and gateway reference</summary>
            <Show when={selectedProfile()}>{(profile) => <div class="admin-profile-reference"><strong>{profile().name}</strong><span>Supported levels: {profile().supportedLevels.join(', ')}</span><span>{offSummary(profile())}</span><For each={profile().limitations ?? []}>{(limitation) => <small>{limitation}</small>}</For></div>}</Show>
            <p class="admin-status-text">Active route version: <span class="admin-mono">{inventoryVersion(route.inventory) ?? route.assignment.routeVersion ?? 'Unavailable'}</span></p>
            <For each={inventoryLegs().filter((leg) => leg.provider.toLowerCase().startsWith('custom'))}>{(leg) => <label class="admin-form-field"><span>Administrator-declared backend · {leg.nodeId}</span><input aria-label={`${leg.nodeId} custom provider backend`} value={route.assignment.legs?.find((item) => item.nodeId === leg.nodeId)?.customProviderBackend ?? leg.customProviderBackend ?? ''} disabled={!route.assignment.activeProfile || verification().busy} onInput={(event) => setLegBackend(route.name, leg.nodeId, event.currentTarget.value)} /><small>Provenance only. Changing this description invalidates its saved verification.</small></label>}</For>
          </details>
          <Show when={pendingRemoval() === route.name}><div class="admin-confirmation" role="alert"><strong>{removalBlockReason(route.name) ? 'Route cannot be removed yet' : 'Confirm route removal'}</strong><p>{removalBlockReason(route.name) || (removalImpact(route.name).length ? `Affected references: ${removalImpact(route.name).join(', ')}. Defaults will move to the first remaining allowed route.` : 'This route has no default or group references.')}</p><div><button autofocus type="button" class="admin-secondary-button" onClick={() => setPendingRemoval(undefined)}>Keep route</button><Show when={!removalBlockReason(route.name)}><button type="button" class="admin-primary-button" aria-label={`Confirm remove ${route.name}`} onClick={() => confirmRemove(route.name)}>Confirm removal</button></Show></div></div></Show>
        </article>;
      }}</For></div>
    </section>

    <Show when={!catalogBusy() && (pendingProfileName() || pendingDraftNames()[0])}>{(profileName) => <div class="admin-unsaved-banner" role="status"><div><strong>{profileName()} is ready to save</strong><span>The profile and its route assignment remain drafts until you confirm Save. Nothing is active yet.</span></div></div>}</Show>

    <details class="admin-routing-section admin-routing-disclosure"><summary><span><strong>Known compatibility limitations</strong><small>{catalog().notices.length} non-assignable records</small></span><span>Advanced information</span></summary><div class="admin-notice-list admin-disclosure-content"><Show when={catalog().notices.length > 0} fallback={<p class="admin-status-text">No compatibility limitations reported.</p>}><For each={catalog().notices}>{(notice) => <article><strong>{notice.name}</strong><span class="admin-status">Not assignable</span><Show when={notice.summary}><p>{notice.summary}</p></Show><For each={notice.limitations ?? []}>{(limitation) => <small>{limitation}</small>}</For></article>}</For></Show></div></details>

    <section class="admin-routing-section admin-defaults-section" aria-labelledby="global-heading"><div class="admin-subsection-heading"><div><h3 id="global-heading">Global fallback defaults</h3><p>Used when no configured Access group matches.</p></div></div><div class="admin-profile-grid"><label class="admin-form-field"><span>Default route</span><select name="defaultRoute" aria-label="Global default route" value={defaultRoute()} onChange={(event) => { setDefaultRoute(event.currentTarget.value); const levels = supportedLevels(event.currentTarget.value); if (!levels.includes(defaultReasoning())) setDefaultReasoning(levels[0] ?? 'off'); }}><For each={routingRoutes()}>{(route) => <option value={route.name} selected={route.name === defaultRoute()}>{route.name}</option>}</For></select></label><label class="admin-form-field"><span>Default reasoning</span><select name="reasoning" aria-label="Global default reasoning" aria-describedby="global-reasoning-help" value={defaultReasoning()} disabled={reasoningDisabled(defaultRoute())} onChange={(event) => setDefaultReasoning(event.currentTarget.value as PiReasoningLevel)}><For each={supportedLevels(defaultRoute())}>{(level) => <option value={level} selected={level === defaultReasoning()}>{level}</option>}</For></select><small id="global-reasoning-help">{reasoningHelp(defaultRoute())}</small></label><Show when={reasoningDisabled(defaultRoute())}><input type="hidden" name="reasoning" value={defaultReasoning()} /></Show></div></section>

    <section class="admin-routing-section admin-groups-section" aria-labelledby="groups-heading">
      <div class="admin-subsection-heading">
        <div><h3 id="groups-heading">Group access and routing</h3><p>Routes are many-to-many. The first configured matching group wins.</p></div>
        <Show when={groups().length > 1}><div class="admin-heading-actions"><label class="admin-form-field"><span>Policy source</span><select value={applyGroupSource()} onChange={(event) => setApplyGroupSource(event.currentTarget.value)}><For each={groups()}>{(group) => <option value={group.accessGroup}>{group.accessGroup}</option>}</For></select></label><button type="button" class="admin-secondary-button" onClick={() => setApplyGroupsOpen(true)}>Apply to all groups</button></div></Show>
      </div>
      <Show when={unconfiguredGroups().length > 0}><div class="admin-add-row"><label class="admin-form-field"><span>Unconfigured access group</span><select aria-label="Unconfigured access group" value={groupToAdd()} onChange={(event) => setGroupToAdd(event.currentTarget.value)}><For each={unconfiguredGroups()}>{(group) => <option value={group}>{group}</option>}</For></select></label><button type="button" class="admin-secondary-button" onClick={addGroupPolicy}>Add group policy</button></div></Show>
      <div class="admin-group-list"><For each={groups()}>{(group) => <fieldset class="admin-group-card"><legend>{group.accessGroup}</legend><button type="button" class="admin-link-button admin-danger-link" aria-label={`Remove ${group.accessGroup} policy`} onClick={() => setGroups((items) => items.filter((item) => item.accessGroup !== group.accessGroup))}>Remove policy</button><fieldset class="admin-fieldset admin-group-routes" aria-label={`${group.accessGroup} allowed routes`}><legend>Allowed routes</legend><div class="admin-route-chip-list"><For each={routingRoutes()}>{(route) => <label class="admin-route-chip"><input type="checkbox" aria-label={`${group.accessGroup} ${route.name} route`} checked={group.routes.includes(route.name)} onChange={() => toggleGroupRoute(group.accessGroup, route.name)} /><span>{route.name}</span></label>}</For></div></fieldset><div class="admin-profile-grid"><label class="admin-form-field"><span>Default route</span><select aria-label={`${group.accessGroup} default route`} value={group.defaultRoute} disabled={group.routes.length === 0} onChange={(event) => setGroups((items) => items.map((item) => item.accessGroup === group.accessGroup ? { ...item, defaultRoute: event.currentTarget.value, reasoning: supportedLevels(event.currentTarget.value).includes(item.reasoning) ? item.reasoning : supportedLevels(event.currentTarget.value)[0] ?? 'off' } : item))}><For each={group.routes}>{(route) => <option value={route} selected={route === group.defaultRoute}>{route}</option>}</For></select></label><label class="admin-form-field"><span>Default reasoning</span><select aria-label={`${group.accessGroup} default reasoning`} aria-describedby={`group-reasoning-${encodeURIComponent(group.accessGroup)}`} value={group.reasoning} disabled={reasoningDisabled(group.defaultRoute)} onChange={(event) => setGroups((items) => items.map((item) => item.accessGroup === group.accessGroup ? { ...item, reasoning: event.currentTarget.value as PiReasoningLevel } : item))}><For each={supportedLevels(group.defaultRoute)}>{(level) => <option value={level} selected={level === group.reasoning}>{level}</option>}</For></select><small id={`group-reasoning-${encodeURIComponent(group.accessGroup)}`}>{reasoningHelp(group.defaultRoute)}</small></label></div></fieldset>}</For></div>
      <Show when={applyGroupsOpen()}><div class="admin-confirmation" role="alert"><strong>Copy one group policy</strong><p>{applyGroupSource()} will be copied to every affected group: {groups().map((group) => group.accessGroup).join(', ')}.</p><div><button autofocus type="button" class="admin-secondary-button" onClick={() => setApplyGroupsOpen(false)}>Cancel</button><button type="button" class="admin-primary-button" onClick={copyGroupToAll}>Confirm group changes</button></div></div></Show>
    </section>

    <For each={routingRoutes()}>{(route) => <input type="hidden" name="dynamicRoutes" value={route.name} />}</For>
    <input type="hidden" name="groupRouting" value={JSON.stringify(groups())} />
    <input type="hidden" name="reasoningConfiguration" value={JSON.stringify(serializedConfiguration())} />
  </div>;
};

export default AiRoutingFields;
/* v8 ignore stop */
