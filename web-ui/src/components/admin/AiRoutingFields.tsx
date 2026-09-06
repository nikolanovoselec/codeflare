/* v8 ignore start -- administration UI exercised by component fixtures */
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type Component } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { discoverReasoningCompatibility, getReasoningCatalog, getReasoningRouteInventory } from '../../api/client';
import type {
  FallbackRouting, PiReasoningLevel, ProfileRevisionRef, ReasoningCatalog, ReasoningConfiguration,
  ReasoningDiscoveryResult, ReasoningGatewayDraft, ReasoningManagementContext, ReasoningProfileCatalogEntry,
  ReasoningRouteAssignment, ReasoningRouteInventory,
} from '../../types';
import ReasoningProfileEditor, { DISCOVERY_COMPLETION_TOKENS, ReasoningCheckDetails, ReasoningCheckOverview, reasoningCheckSummary } from './ReasoningProfileEditor';
import { profileDisplayName, profileValidationBasis } from './pi-profile-presentation';
import '../../styles/ai-routing-workspace.css';

interface Props { current: unknown; onReadyChange?: (ready: boolean) => void; onDirtyChange?: (dirty: boolean) => void }
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
interface VerificationDraft { busy?: boolean; result?: ReasoningDiscoveryResult; error?: string; routeChanged?: boolean }
const LEVELS: PiReasoningLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_CONTEXT_WINDOW = 256000;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const isLevel = (value: unknown): value is PiReasoningLevel => LEVELS.includes(value as PiReasoningLevel);
const levelLabel = (level: string) => level.charAt(0).toUpperCase() + level.slice(1);
const refKey = (ref?: ProfileRevisionRef): string => ref ? `${ref.id}\u001f${ref.revision}\u001f${ref.hash}` : '';
const profileRefFromEntry = (profile: ReasoningProfileCatalogEntry): ProfileRevisionRef => ({ id: profile.id, revision: profile.revision, hash: profile.hash });
const inventoryVersion = (inventory?: ReasoningRouteInventory) => inventory?.routeVersion ?? inventory?.versionId;
function profileRef(value: unknown): ProfileRevisionRef | undefined {
  const candidate = record(value);
  return typeof candidate.id === 'string' && typeof candidate.revision === 'number' && typeof candidate.hash === 'string'
    ? { id: candidate.id, revision: candidate.revision, hash: candidate.hash } : undefined;
}
function routeAssignment(value: unknown): AssignmentDraft {
  const candidate = record(value);
  return {
    ...(profileRef(candidate.activeProfile) && { activeProfile: profileRef(candidate.activeProfile) }),
    ...(text(candidate.routeVersion) && { routeVersion: text(candidate.routeVersion) }),
    ...(Array.isArray(candidate.legs) && { legs: JSON.parse(JSON.stringify(candidate.legs)) }),
    ...(Boolean(candidate.commonMapping) && { commonMapping: JSON.parse(JSON.stringify(candidate.commonMapping)) }),
    ...(Boolean(candidate.verification) && { verification: JSON.parse(JSON.stringify(candidate.verification)) }),
  };
}
function groupDrafts(value: unknown): GroupDraft[] {
  const source = Array.isArray(value) ? value : Object.entries(record(value)).map(([accessGroup, routing]) => ({ accessGroup, ...record(routing) }));
  return source.map((item) => {
    const group = record(item);
    return { accessGroup: text(group.accessGroup), routes: stringList(group.routes), defaultRoute: text(group.defaultRoute), reasoning: isLevel(group.reasoning) ? group.reasoning : 'off' as PiReasoningLevel };
  }).filter((group) => group.accessGroup);
}
function completeVerification(result: ReasoningDiscoveryResult): boolean {
  return result.assignable === true && result.classification === 'Verified' && Boolean(result.checkId && result.verification)
    && !result.diagnostics?.length && !result.candidateResults?.some((candidate) => candidate.diagnostics?.length);
}

interface PolicyFieldsProps {
  label: string;
  options: RouteDraft[];
  policy: Pick<GroupDraft, 'routes' | 'defaultRoute' | 'reasoning'>;
  levels: PiReasoningLevel[];
  onToggle: (route: string) => void;
  onDefault: (route: string) => void;
  onReasoning: (level: PiReasoningLevel) => void;
}
const PolicyFields: Component<PolicyFieldsProps> = (props) => <div class="admin-policy-fields">
  <fieldset class="admin-fieldset" aria-label={`${props.label} allowed routes`}>
    <legend>Available routes</legend>
    <p class="admin-field-help">Only routes with a successful current check can be assigned.</p>
    <Show when={props.options.length} fallback={<p class="admin-status-text">Verify a route in Routes before assigning access.</p>}>
      <div class="admin-policy-routes"><For each={props.options}>{(route) => <label>
        <input type="checkbox" aria-label={`${props.label} ${route.name} route`} checked={props.policy.routes.includes(route.name)} onChange={() => props.onToggle(route.name)} />
        <span>{route.name}</span>
        <Show when={route.assignment.verification?.scope === 'observed-path'}><small>Backup untested</small></Show>
      </label>}</For></div>
    </Show>
  </fieldset>
  <div class="admin-route-controls">
    <label class="admin-form-field"><span>Default route</span><select aria-label={`${props.label} default route`} value={props.policy.defaultRoute} disabled={!props.policy.routes.length} onChange={(event) => props.onDefault(event.currentTarget.value)}>
      <Show when={!props.policy.routes.length}><option value="">Select an available route</option></Show>
      <For each={props.policy.routes}>{(route) => <option value={route} selected={route === props.policy.defaultRoute}>{route}</option>}</For>
    </select><small>The route Pi starts with for this policy.</small></label>
    <label class="admin-form-field"><span>Default reasoning</span><select aria-label={`${props.label} default reasoning`} aria-describedby={`${encodeURIComponent(props.label)}-reasoning-help`} value={props.policy.reasoning} disabled={props.levels.length <= 1} onChange={(event) => props.onReasoning(event.currentTarget.value as PiReasoningLevel)}>
      <For each={props.levels}>{(level) => <option value={level} selected={level === props.policy.reasoning}>{levelLabel(level)}</option>}</For>
    </select><small id={`${encodeURIComponent(props.label)}-reasoning-help`}>{!props.policy.defaultRoute ? 'Choose an available route first.' : props.levels.length === 1 ? `This profile supports only ${levelLabel(props.levels[0])}.` : `Only options supported by this route's Pi compatibility profile are available.${props.levels.includes('off') ? '' : ' Off is not supported.'}`}</small></label>
  </div>
</div>;

const AiRoutingFields: Component<Props> = (props) => {
  const current = record(props.current);
  const configuration = record(current.reasoningConfiguration);
  const assignments = record(configuration.routeAssignments);
  const contextWindows = record(current.routeContextWindows);
  const storedRoutes = [...new Set([...stringList(current.dynamicRoutes), ...Object.keys(assignments)])];
  const [routeState, setRouteState] = createStore<RouteDraft[]>(storedRoutes.map((name) => ({ name, contextWindow: typeof contextWindows[name] === 'number' ? contextWindows[name] as number : DEFAULT_CONTEXT_WINDOW, assignment: routeAssignment(assignments[name]) })));
  const routes = () => routeState;
  const setRoutes = (update: (items: RouteDraft[]) => RouteDraft[]) => setRouteState(reconcile(update(routeState), { key: 'name' }));
  const updateRoute = (name: string, update: (route: RouteDraft) => RouteDraft) => setRoutes((items) => items.map((route) => route.name === name ? update(route) : route));
  const routeByName = (name: string) => routes().find((route) => route.name === name);
  const [gatewayRoutes, setGatewayRoutes] = createSignal<string[]>([]);
  const [gatewayUrl, setGatewayUrl] = createSignal(text(current.gatewayUrl));
  const [replacementToken, setReplacementToken] = createSignal(text(current.replacementToken));
  const [checkedConnection, setCheckedConnection] = createSignal<string>();
  const connectionKey = () => JSON.stringify([gatewayUrl().trim(), replacementToken().trim()]);
  const gatewayDraft = (): ReasoningGatewayDraft | undefined => gatewayUrl().trim() !== text(current.savedGatewayUrl ?? current.gatewayUrl).trim() || replacementToken().trim()
    ? { gatewayUrl: gatewayUrl().trim(), ...(replacementToken().trim() && { replacementToken: replacementToken().trim() }) } : undefined;
  const [catalog, setCatalog] = createSignal<ReasoningCatalog>({ schemaVersion: 1, profiles: [], notices: [], usage: [], routes: [], routeCatalogStatus: 'unavailable' });
  const [catalogBusy, setCatalogBusy] = createSignal(true);
  const [catalogError, setCatalogError] = createSignal('');
  const connectionReady = () => !catalogBusy() && !catalogError() && catalog().routeCatalogStatus === 'ready' && checkedConnection() === connectionKey();
  const [section, setSection] = createSignal<'connection' | 'routes' | 'access'>('routes');
  const [expandedRoute, setExpandedRoute] = createSignal<string>();
  const [groups, setGroups] = createSignal<GroupDraft[]>(groupDrafts(current.groupRouting));
  const [expandedGroup, setExpandedGroup] = createSignal<string | undefined>(groups()[0]?.accessGroup);
  const availableAccessGroups = stringList(current.availableAccessGroups);
  const unconfiguredGroups = createMemo(() => availableAccessGroups.filter((name) => !groups().some((group) => group.accessGroup === name)));
  const [groupToAdd, setGroupToAdd] = createSignal(unconfiguredGroups()[0] ?? '');
  const fallback = record(current.fallbackRouting ?? configuration.fallbackRouting);
  const [fallbackEnabled, setFallbackEnabled] = createSignal(fallback.enabled === true);
  const [fallbackPolicy, setFallbackPolicy] = createSignal({ routes: stringList(fallback.routes), defaultRoute: text(fallback.defaultRoute), reasoning: isLevel(fallback.reasoning) ? fallback.reasoning : 'off' as PiReasoningLevel });
  const [customRevisions, setCustomRevisions] = createSignal<Array<Record<string, unknown>>>(Array.isArray(configuration.customProfileRevisions) ? configuration.customProfileRevisions.map(record) : []);
  const [routeChecks, setRouteChecks] = createSignal<Record<string, string | null>>(Object.fromEntries(Object.entries(record(current.routeChecks)).filter((entry): entry is [string, string | null] => typeof entry[1] === 'string' || entry[1] === null)));
  const [profileEditorRoute, setProfileEditorRoute] = createSignal<string>();
  const [profileEditorBusy, setProfileEditorBusy] = createSignal(false);
  const [pendingProfileName, setPendingProfileName] = createSignal('');
  const [pendingRemoval, setPendingRemoval] = createSignal<string>();
  const [applyGroupsOpen, setApplyGroupsOpen] = createSignal(false);
  const [applyGroupSource, setApplyGroupSource] = createSignal(groups()[0]?.accessGroup ?? '');
  const [verifications, setVerifications] = createSignal<Record<string, VerificationDraft>>({});
  const verificationFor = (name: string): VerificationDraft => verifications()[name] ?? {};
  const updateVerification = (name: string, update: VerificationDraft) => setVerifications((items) => ({ ...items, [name]: update }));
  const checksBusy = () => profileEditorBusy() || Object.values(verifications()).some((value) => value.busy);
  // REQ-ENTERPRISE-044: compare editable semantics, not inventory-driven policy normalization.
  const draftKey = () => JSON.stringify({
    gatewayUrl: gatewayUrl().trim(), replacementToken: replacementToken().trim(),
    routes: routes().filter((route) => storedRoutes.includes(route.name) || route.assignment.activeProfile || route.contextWindow !== DEFAULT_CONTEXT_WINDOW)
      .map((route) => ({ name: route.name, contextWindow: route.contextWindow, assignment: route.assignment })).sort((a, b) => a.name.localeCompare(b.name)),
    groups: groups().map((group) => ({ ...group, routes: [...group.routes].sort() })),
    fallback: fallbackEnabled() ? { enabled: true, ...fallbackPolicy(), routes: [...fallbackPolicy().routes].sort() } : { enabled: false },
    customRevisions: customRevisions(),
  });
  const initialDraftKey = draftKey();
  createEffect(() => props.onDirtyChange?.(draftKey() !== initialDraftKey));
  let disposed = false;
  onCleanup(() => { disposed = true; });

  const assignableProfiles = createMemo(() => [...catalog().profiles, ...customRevisions()
    .filter((revision) => !catalog().profiles.some((profile) => profile.id === revision.id && profile.revision === revision.revision))
    .flatMap((revision): ReasoningProfileCatalogEntry[] => {
      const ref = profileRef(revision);
      return ref ? [{ ...revision, ...ref, name: text(revision.name), enabled: revision.enabled !== false, supportedLevels: stringList(revision.supportedLevels).filter(isLevel) }] : [];
    })].filter((profile) => profile.enabled !== false && profile.assignable !== false));
  const findProfile = (ref?: ProfileRevisionRef) => assignableProfiles().find((profile) => refKey(profile) === refKey(ref));
  const supportedLevels = (name: string) => findProfile(routeByName(name)?.assignment.activeProfile)?.supportedLevels ?? [];
  const preferredLevel = (name: string): PiReasoningLevel => {
    const levels = supportedLevels(name);
    return levels.includes('medium') ? 'medium' : levels.includes('off') ? 'off' : levels[0] ?? 'off';
  };
  const validContext = (route: RouteDraft) => Number.isSafeInteger(route.contextWindow) && route.contextWindow > 0;
  const verifiedAssignment = (route: RouteDraft): boolean => {
    const proof = route.assignment.verification;
    const inventory = route.inventory;
    const profile = findProfile(route.assignment.activeProfile);
    if (!connectionReady() || !profile || !proof || !inventory || route.inventoryBusy || route.inventoryError || verificationFor(route.name).busy) return false;
    if (!inventory.inventoryDigest || proof.inventoryDigest !== inventory.inventoryDigest || proof.routeVersion !== inventoryVersion(inventory)
      || refKey(proof.profileRef) !== refKey(route.assignment.activeProfile) || !profile.supportedLevels.every((level) => proof.supportedLevels?.includes(level))) return false;
    if (routeChecks()[route.name] === null) return false;
    if (!routeChecks()[route.name] && (!inventory.verification || inventory.verification.connectionFingerprint !== proof.connectionFingerprint
      || inventory.verification.inventoryDigest !== proof.inventoryDigest || refKey(inventory.verification.profileRef) !== refKey(proof.profileRef))) return false;
    return proof.scope === 'observed-path' || (proof.scope === 'single-model' && inventory.legs.length === 1);
  };
  const eligibleRoutes = createMemo(() => routes().filter((route) => gatewayRoutes().includes(route.name) && verifiedAssignment(route) && validContext(route)));
  const eligibleNames = () => eligibleRoutes().map((route) => route.name);
  const normalizedPolicy = <T extends Pick<GroupDraft, 'routes' | 'defaultRoute' | 'reasoning'>>(policy: T): T => {
    const selected = policy.routes.filter((name) => eligibleNames().includes(name));
    const defaultRoute = selected.includes(policy.defaultRoute) ? policy.defaultRoute : selected[0] ?? '';
    const reasoning = defaultRoute === policy.defaultRoute && supportedLevels(defaultRoute).includes(policy.reasoning) ? policy.reasoning : preferredLevel(defaultRoute);
    return { ...policy, routes: selected, defaultRoute, reasoning };
  };
  const configuredGroups = createMemo(() => groups().map(normalizedPolicy));
  const activeGroups = createMemo(() => configuredGroups().filter((group) => group.routes.length > 0));
  const normalizedFallback = () => normalizedPolicy(fallbackPolicy());
  const fallbackRouting = (): FallbackRouting => fallbackEnabled() ? { enabled: true, ...normalizedFallback() } : { enabled: false };
  const activeNames = createMemo(() => [...new Set([...activeGroups().flatMap((group) => group.routes), ...(fallbackEnabled() ? normalizedFallback().routes : [])])]);
  // REQ-ENTERPRISE-044: pending-policy-inventory must settle before Save can normalize selections.
  const policyInventoryPending = () => [...groups().flatMap((group) => group.routes), ...(fallbackEnabled() ? fallbackPolicy().routes : [])]
    .some((name) => gatewayRoutes().includes(name) && Boolean(routeByName(name)?.inventoryBusy));
  const canSave = () => connectionReady() && !policyInventoryPending() && !checksBusy() && activeGroups().length > 0 && (!fallbackEnabled() || normalizedFallback().routes.length > 0);
  const saveHelp = () => !connectionReady() ? 'Check the AI Gateway connection before saving.' : policyInventoryPending() ? 'Wait for selected route models to finish loading.' : checksBusy() ? 'Wait for the current profile check to finish.' : !eligibleRoutes().length ? 'Verify at least one route before assigning access and saving.' : !activeGroups().length ? 'Assign a checked route to at least one group before saving.' : fallbackEnabled() && !normalizedFallback().routes.length ? 'Choose a checked route for fallback access, or turn fallback off.' : '';
  createEffect(() => props.onReadyChange?.(canSave()));

  const clearRouteVerification = (name: string) => {
    setRouteChecks((checks) => ({ ...checks, [name]: null }));
    updateVerification(name, {});
    updateRoute(name, (route) => ({ ...route, assignment: { ...route.assignment, verification: undefined, commonMapping: undefined,
      ...(route.assignment.legs && { legs: route.assignment.legs.map((leg) => ({ ...leg, ...(leg.evidence && { evidence: { ...leg.evidence, current: false, status: 'stale' } }) })) }),
    } }));
  };
  const changeConnection = (field: 'url' | 'token', value: string) => {
    if (field === 'url') setGatewayUrl(value); else setReplacementToken(value);
    setCheckedConnection(undefined);
    for (const route of routes()) clearRouteVerification(route.name);
  };
  const managementContext = (name: string): ReasoningManagementContext | undefined => {
    const descriptions = Object.fromEntries((routeByName(name)?.assignment.legs ?? []).filter((leg) => leg.provider.toLowerCase().startsWith('custom') && leg.customProviderBackend).map((leg) => [leg.nodeId, leg.customProviderBackend!]));
    const gateway = gatewayDraft();
    return gateway || Object.keys(descriptions).length ? { ...(gateway && { gateway }), ...(Object.keys(descriptions).length && { backendDescriptions: descriptions }) } : undefined;
  };
  const inspect = async (name: string): Promise<ReasoningRouteInventory | undefined> => {
    updateRoute(name, (route) => ({ ...route, inventoryBusy: true, inventoryError: undefined }));
    try {
      const context = managementContext(name);
      const inventory = context ? await getReasoningRouteInventory(name, context) : await getReasoningRouteInventory(name);
      if (disposed) return;
      updateRoute(name, (route) => ({ ...route, inventory, inventoryBusy: false }));
      return inventory;
    } catch {
      if (!disposed) updateRoute(name, (route) => ({ ...route, inventory: undefined, inventoryBusy: false, inventoryError: 'Models could not be read. Refresh models or check the connection.' }));
      return undefined;
    }
  };
  const checkConnection = async () => {
    setCatalogBusy(true); setCatalogError('');
    const key = connectionKey();
    try {
      const gateway = gatewayDraft();
      const loaded = gateway ? await getReasoningCatalog(gateway) : await getReasoningCatalog();
      if (disposed || key !== connectionKey()) return;
      setCatalog(loaded);
      if (loaded.routeCatalogStatus === 'ready') {
        setCheckedConnection(key); setGatewayRoutes(loaded.routes);
        setRoutes((items) => {
          const byName = new Map(items.map((route) => [route.name, route]));
          return [...loaded.routes.map((name) => byName.has(name) ? { ...byName.get(name)!, inventoryBusy: true } : { name, contextWindow: DEFAULT_CONTEXT_WINDOW, assignment: routeAssignment(assignments[name]), inventoryBusy: true }), ...items.filter((route) => !loaded.routes.includes(route.name)).map((route) => ({ ...route }))];
        });
      } else setCheckedConnection(undefined);
    } catch {
      if (!disposed) { setCheckedConnection(undefined); setCatalogError('The connection could not be checked. Try again.'); }
    } finally { if (!disposed) setCatalogBusy(false); }
    if (connectionReady()) for (const name of gatewayRoutes()) { if (disposed) break; await inspect(name); }
  };
  onMount(() => { void checkConnection(); });

  const setRouteProfile = (name: string, key: string) => {
    const selected = assignableProfiles().find((profile) => refKey(profile) === key);
    clearRouteVerification(name);
    updateRoute(name, (route) => ({ ...route, assignment: { ...route.assignment, activeProfile: selected ? profileRefFromEntry(selected) : undefined,
      ...(route.assignment.legs && { legs: route.assignment.legs.map((leg) => ({ ...leg, ...(selected && { profileRef: profileRefFromEntry(selected) }) })) }),
    } }));
  };
  const needsBackendDescription = (route: RouteDraft) => (route.inventory?.legs ?? []).some((leg) => leg.provider.toLowerCase().startsWith('custom') && !(route.assignment.legs?.find((draft) => draft.nodeId === leg.nodeId)?.customProviderBackend ?? leg.customProviderBackend ?? '').trim());
  const verifySelectedProfile = async (name: string) => {
    const route = routeByName(name);
    if (!route?.assignment.activeProfile || !findProfile(route.assignment.activeProfile) || !connectionReady() || needsBackendDescription(route) || verificationFor(name).busy) return;
    const selectedRef = { ...route.assignment.activeProfile };
    const profileDraft = customRevisions().find((profile) => refKey(profileRef(profile)) === refKey(selectedRef) && !catalog().profiles.some((saved) => refKey(saved) === refKey(selectedRef)));
    const connection = connectionKey();
    clearRouteVerification(name); updateVerification(name, { busy: true });
    try {
      const before = await inspect(name);
      if (!before?.inventoryDigest) throw new Error('inventory_unavailable');
      const result = await discoverReasoningCompatibility({ route: name, profileRef: selectedRef, ...(profileDraft && { profileDraft }), ...managementContext(name), maxCompletionTokens: DISCOVERY_COMPLETION_TOKENS });
      if (disposed) return;
      const after = await inspect(name);
      const currentRoute = routeByName(name);
      if (!currentRoute || connection !== connectionKey() || refKey(currentRoute.assignment.activeProfile) !== refKey(selectedRef)) return;
      const changed = !after?.inventoryDigest || before.inventoryDigest !== after.inventoryDigest || (result.verification && result.verification.inventoryDigest !== after.inventoryDigest);
      updateVerification(name, { result, routeChanged: changed });
      if (!changed && completeVerification(result) && result.verification && refKey(result.verification.profileRef) === refKey(selectedRef)) {
        setRouteChecks((checks) => ({ ...checks, [name]: result.checkId! }));
        // REQ-ENTERPRISE-038: reconcile-verified-legs uses fresh identities, never per-leg proof from a route receipt.
        updateRoute(name, (item) => ({ ...item, assignment: { ...item.assignment,
          ...(item.assignment.legs && { legs: after!.legs.map((leg) => {
            const declared = item.assignment.legs?.find((saved) => saved.nodeId === leg.nodeId && saved.provider === leg.provider);
            const backend = declared?.customProviderBackend ?? leg.customProviderBackend;
            return { nodeId: leg.nodeId, provider: leg.provider, declaredModel: leg.declaredModel,
              profileRef: declared?.profileRef ?? selectedRef,
              ...(leg.provider.toLowerCase().startsWith('custom') && backend && { customProviderBackend: backend }),
            };
          }) }),
          routeVersion: result.verification!.routeVersion, verification: { ...result.verification! },
        } }));
      }
    } catch {
      if (!disposed) updateVerification(name, { error: 'Verification failed. Check the connection and try again. This route cannot be activated.' });
    }
  };
  const setLegBackend = (name: string, nodeId: string, backend: string) => {
    clearRouteVerification(name);
    updateRoute(name, (route) => ({ ...route, assignment: { ...route.assignment,
      legs: (route.inventory?.legs ?? route.assignment.legs ?? []).map((leg) => ({
        ...route.assignment.legs?.find((draft) => draft.nodeId === leg.nodeId),
        nodeId: leg.nodeId, provider: leg.provider, declaredModel: leg.declaredModel, profileRef: route.assignment.activeProfile,
        ...(leg.provider.toLowerCase().startsWith('custom') && { customProviderBackend: leg.nodeId === nodeId ? backend : route.assignment.legs?.find((draft) => draft.nodeId === leg.nodeId)?.customProviderBackend ?? leg.customProviderBackend ?? '' }),
      })),
    } }));
  };
  const routeStatus = (route: RouteDraft): { label: string; state: 'passed' | 'failed' | 'unclear' } => {
    const check = verificationFor(route.name);
    if (profileEditorRoute() === route.name && profileEditorBusy()) return { label: 'Mapping…', state: 'unclear' };
    if (check.busy) return { label: 'Verifying…', state: 'unclear' };
    if (check.error || check.result?.classification === 'Unsupported') return { label: 'Check failed · inactive', state: 'failed' };
    if (!route.assignment.activeProfile) return { label: 'Choose a profile', state: 'unclear' };
    if (verifiedAssignment(route)) return !validContext(route) ? { label: 'Set context window', state: 'unclear' } : route.assignment.verification?.scope === 'observed-path' ? { label: 'Compatible · backup untested', state: 'unclear' } : { label: 'Verified', state: 'passed' };
    return { label: 'Needs verification · inactive', state: 'unclear' };
  };
  const togglePolicyRoute = <T extends Pick<GroupDraft, 'routes' | 'defaultRoute' | 'reasoning'>>(policy: T, name: string): T => {
    if (!eligibleNames().includes(name)) return policy;
    const clean = normalizedPolicy(policy);
    const selected = clean.routes.includes(name) ? clean.routes.filter((route) => route !== name) : [...clean.routes, name];
    const defaultRoute = selected.includes(clean.defaultRoute) ? clean.defaultRoute : selected[0] ?? '';
    return { ...clean, routes: selected, defaultRoute, reasoning: defaultRoute === clean.defaultRoute ? clean.reasoning : preferredLevel(defaultRoute) };
  };
  const addGroupPolicy = () => {
    const accessGroup = groupToAdd();
    if (!unconfiguredGroups().includes(accessGroup)) return;
    const selected = eligibleNames().length === 1 ? eligibleNames() : [];
    setGroups((items) => [...items, { accessGroup, routes: selected, defaultRoute: selected[0] ?? '', reasoning: preferredLevel(selected[0] ?? '') }]);
    setExpandedGroup(accessGroup); setGroupToAdd(unconfiguredGroups()[0] ?? '');
  };
  const copyGroupToAll = () => {
    const source = groups().find((group) => group.accessGroup === applyGroupSource());
    if (source) { const clean = normalizedPolicy(source); setGroups((items) => items.map((group) => ({ ...group, routes: [...clean.routes], defaultRoute: clean.defaultRoute, reasoning: clean.reasoning }))); }
    setApplyGroupsOpen(false);
  };
  const confirmRemove = (name: string) => {
    setRoutes((items) => items.filter((route) => route.name !== name));
    setGroups((items) => items.map((group) => normalizedPolicy({ ...group, routes: group.routes.filter((route) => route !== name) })));
    setFallbackPolicy((policy) => normalizedPolicy({ ...policy, routes: policy.routes.filter((route) => route !== name) }));
    setPendingRemoval(undefined);
  };
  const serializedConfiguration = createMemo<ReasoningConfiguration>(() => ({ schemaVersion: 1, customProfileRevisions: customRevisions(), fallbackRouting: fallbackRouting(),
    routeAssignments: Object.fromEntries(routes().flatMap((route) => route.assignment.activeProfile ? [[route.name, { ...route.assignment, activeProfile: route.assignment.activeProfile,
      ...(route.assignment.legs && { legs: route.assignment.legs.filter((leg) => !leg.provider.toLowerCase().startsWith('custom') || Boolean(leg.customProviderBackend)) }),
    } satisfies ReasoningRouteAssignment]] : [])),
  }));
  const compatibilityDefault = () => fallbackEnabled() && normalizedFallback().routes.length ? normalizedFallback() : activeGroups()[0];

  return <div class="admin-ai-routing admin-form-wide admin-routing-workspace">
    <div class="admin-routing-intro"><h3>Connect, verify, then grant access</h3><p>Only checked routes can be activated. Unfinished routes stay inactive while you save the working ones.</p></div>
    <section class="admin-connection-status" aria-label="AI Gateway connection status" data-state={connectionReady() ? 'passed' : catalogBusy() ? 'unclear' : 'failed'}>
      <div><strong>AI Gateway</strong><span role="status">{catalogBusy() ? 'Checking connection…' : connectionReady() ? `Connected · ${gatewayRoutes().length} routes readable` : checkedConnection() !== connectionKey() && catalog().routeCatalogStatus === 'ready' ? 'Connection changed · check required' : 'Connection needs attention'}</span></div>
      <Show when={!connectionReady() && !catalogBusy()}><p role="alert">{catalogError() || (catalog().routeCatalogStatus === 'ready' ? 'Check the edited connection before verifying routes.' : catalog().connection?.message) || 'Routes could not be read. Check the gateway URL, token, and AI Gateway Read permission.'}</p></Show>
    </section>
    <nav class="admin-routing-nav" aria-label="AI Gateway configuration sections">
      <button type="button" aria-pressed={section() === 'connection'} onClick={() => setSection('connection')}>Connection</button>
      <button type="button" aria-pressed={section() === 'routes'} onClick={() => setSection('routes')}>Routes</button>
      <button type="button" aria-pressed={section() === 'access'} onClick={() => setSection('access')}>Access &amp; fallback</button>
    </nav>

    <section hidden={section() !== 'connection'} class="admin-routing-pane" aria-labelledby="connection-heading">
      <h3 id="connection-heading">AI Gateway connection</h3><p>Check that Codeflare can read your routes. Profile verification separately checks model requests and tool calling.</p>
      <div class="admin-route-controls">
        <label class="admin-form-field"><span>AI Gateway URL</span><input name="gatewayUrl" type="url" value={gatewayUrl()} disabled={checksBusy()} onInput={(event) => changeConnection('url', event.currentTarget.value)} /></label>
        <label class="admin-form-field"><span>Replacement API token</span><input aria-label="Replacement API token" name="replacementToken" type="password" value={replacementToken()} autocomplete="new-password" disabled={checksBusy()} onInput={(event) => changeConnection('token', event.currentTarget.value)} /><small>Leave blank to keep the saved token. Token permissions must allow route reads and gateway requests.</small></label>
      </div>
      <button type="button" class="admin-secondary-button" disabled={catalogBusy() || checksBusy()} onClick={() => void checkConnection()}>Check connection</button>
      <p class="admin-field-help">Connection checks do not save credentials or run paid model probes.</p>
    </section>

    <section hidden={section() !== 'routes'} class="admin-routing-pane" aria-labelledby="routes-heading">
      <div class="admin-subsection-heading"><div><h3 id="routes-heading">Routes</h3><p>Choose a route to configure it. A Pi compatibility profile translates Pi requests for tool calling and reasoning before AI Gateway selects a backend.</p></div><span class="admin-status">{eligibleRoutes().length} ready / {routes().length} routes</span></div>
      <Show when={!catalogBusy() && routes().length === 0}><p class="admin-status-text">No routes available. Create a dynamic route in AI Gateway, then check the connection again.</p></Show>
      <div class="admin-route-overview"><For each={routes()}>{(route) => {
        const profile = () => findProfile(route.assignment.activeProfile);
        const check = () => verificationFor(route.name);
        const legs = () => route.inventory?.legs ?? [];
        return <article class="admin-route-entry" aria-label={`${route.name} route`}>
          <button type="button" class="admin-route-toggle" aria-label={`Configure ${route.name}`} aria-expanded={expandedRoute() === route.name} aria-controls={`route-panel-${encodeURIComponent(route.name)}`} onClick={() => setExpandedRoute(expandedRoute() === route.name ? undefined : route.name)}>
            <span><strong>{route.name}</strong><small>{activeNames().includes(route.name) ? 'Assigned to access policy' : 'Not active in a policy'}</small></span>
            <span class="admin-check-pill" data-state={routeStatus(route).state}>{routeStatus(route).label}</span><span class="admin-route-chevron" aria-hidden="true">›</span>
          </button>
          <div hidden={expandedRoute() !== route.name} id={`route-panel-${encodeURIComponent(route.name)}`} class="admin-route-panel">
            <section class="admin-route-models" aria-label={`${route.name} detected models`}><div class="admin-model-heading"><strong>Models behind this route</strong><button type="button" class="admin-link-button" aria-label={`Refresh ${route.name} models`} disabled={!connectionReady() || route.inventoryBusy || check().busy} onClick={() => void inspect(route.name)}>Refresh models</button></div>
              <Show when={route.inventoryBusy}><p class="admin-status-text">Loading models…</p></Show><Show when={route.inventoryError}><p role="alert" class="admin-inline-error">{route.inventoryError}</p></Show>
              <ul class="admin-model-list"><For each={legs()}>{(leg) => <li><strong>{leg.declaredModel}</strong><span>{leg.provider}</span></li>}</For></ul>
              <Show when={legs().length > 1}><p class="admin-field-help">AI Gateway may use a backup or another branch. A check tests the path selected for that request.</p></Show>
            </section>
            <div class="admin-route-controls">
              <label class="admin-form-field"><span>Pi compatibility profile</span><select aria-label={`${route.name} Pi compatibility profile`} value={refKey(route.assignment.activeProfile)} disabled={catalogBusy() || check().busy || profileEditorBusy()} onChange={(event) => { setProfileEditorRoute(undefined); setRouteProfile(route.name, event.currentTarget.value); }}>
                <option value="" selected={!route.assignment.activeProfile}>Choose a profile</option><For each={assignableProfiles()}>{(option) => <option value={refKey(option)} selected={refKey(option) === refKey(route.assignment.activeProfile)}>{profileDisplayName(option)}</option>}</For>
              </select><small>Mapping translates request settings; it does not identify the model behind a route.</small></label>
              <label class="admin-form-field"><span>Context window</span><input type="text" inputmode="numeric" aria-label={`${route.name} context window`} value={route.contextWindow} onInput={(event) => updateRoute(route.name, (item) => ({ ...item, contextWindow: Number(event.currentTarget.value) }))} /><small>Maximum conversation size, in tokens.</small></label>
            </div>
            <Show when={!validContext(route)}><p class="admin-inline-error">Enter a positive whole-number context window before activating this route.</p></Show>
            <Show when={profile()}>{(selected) => <div class="admin-profile-explanation">
              <strong>{profileDisplayName(selected())}</strong><Show when={profileValidationBasis(selected())}>{(basis) => <p>{basis()}</p>}</Show>
              <dl><div><dt>Reasoning options</dt><dd>{selected().supportedLevels.map(levelLabel).join(', ')}</dd></div><div><dt>Reasoning off</dt><dd>{selected().supportedLevels.includes('off') ? 'Supported' : 'Not supported'}</dd></div></dl>
            </div>}</Show>
            <div class="admin-route-actions"><button type="button" class="admin-secondary-button" aria-label={`Map Profile for ${route.name}`} disabled={!connectionReady() || check().busy || Boolean(profileEditorRoute()) || !gatewayRoutes().includes(route.name)} onClick={() => setProfileEditorRoute(route.name)}>Map Profile</button>
              <button type="button" class="admin-primary-button" aria-label={`Verify Profile for ${route.name}`} disabled={!connectionReady() || !profile() || needsBackendDescription(route) || check().busy || route.inventoryBusy || profileEditorBusy() || !gatewayRoutes().includes(route.name)} onClick={() => { setProfileEditorRoute(undefined); void verifySelectedProfile(route.name); }}>{check().busy ? 'Verifying…' : 'Verify Profile'}</button>
            </div>
            <p class="admin-field-help">Map finds compatible profiles. If none fit, a successful mapping can offer custom Create &amp; Assign. Verify checks your selection. Checks may use provider credits; Save activates your settings.</p>
            <Show when={check().error}><p role="alert" class="admin-inline-error">{check().error}</p></Show>
            <Show when={check().routeChanged}><p role="alert" class="admin-inline-error">The route changed during verification. Check it again before assigning access.</p></Show>
            <Show when={verifiedAssignment(route) && route.assignment.verification?.scope === 'observed-path'}><p class="admin-route-scope-warning" role="status">The tested path passed. Other backends remain untested. This route can be assigned with that warning.</p></Show>
            <Show when={check().result}>{(result) => <section class="admin-route-verification" aria-label={`${route.name} profile verification`}>
              <ReasoningCheckOverview result={result()} levels={profile()?.supportedLevels ?? []} />
              <Show when={!completeVerification(result())}><p class="admin-status-text">{reasoningCheckSummary(result())}</p></Show>
              <Show when={verifiedAssignment(route)}><p class="admin-status-text">Check passed. Assign access and confirm Save to activate this draft.</p></Show><ReasoningCheckDetails result={result()} />
            </section>}</Show>
            <Show when={check().busy}><div class="admin-state-panel" role="status" aria-live="polite"><strong>Verifying profile for {route.name}…</strong><p>Checking reasoning, tool calls, and tool-result replay. Results appear when the check finishes.</p></div></Show>
            <Show when={profileEditorRoute() === route.name}><ReasoningProfileEditor route={route.name} context={managementContext(route.name)} onBusyChange={setProfileEditorBusy} existingRevisions={customRevisions()} onCancel={() => setProfileEditorRoute(undefined)} onSelectProfile={(ref) => { setProfileEditorRoute(undefined); setRouteProfile(route.name, refKey(ref)); }} onSave={(revision) => { setProfileEditorRoute(undefined); setCustomRevisions((items) => [...items, revision]); setRouteProfile(route.name, refKey(profileRef(revision))); setPendingProfileName(String(revision.name ?? 'New profile')); }} /></Show>
            <Show when={needsBackendDescription(route)}><p class="admin-field-help">Describe each custom-provider backend below before Verify. This does not require Save first.</p></Show>
            <details class="admin-route-reference" open={needsBackendDescription(route)}><summary>Advanced profile and gateway details</summary>
              <Show when={profile()}>{(selected) => <><dl><div><dt>Profile revision</dt><dd>{selected().revision}</dd></div><div><dt>Profile reference</dt><dd class="admin-mono">{selected().id}</dd></div></dl><Show when={selected().limitations?.length}><strong>Original validation notes</strong><p class="admin-field-help">These describe the profile's test history, not the current route.</p><ul><For each={selected().limitations ?? []}>{(note) => <li>{note}</li>}</For></ul></Show></>}</Show>
              <p>Gateway route version: <span class="admin-mono">{inventoryVersion(route.inventory) ?? 'Unavailable'}</span></p>
              <For each={legs().filter((leg) => leg.provider.toLowerCase().startsWith('custom'))}>{(leg) => <label class="admin-form-field"><span>Backend description · {leg.nodeId}</span><input aria-label={`${leg.nodeId} custom provider backend`} value={route.assignment.legs?.find((item) => item.nodeId === leg.nodeId)?.customProviderBackend ?? leg.customProviderBackend ?? ''} disabled={!profile() || check().busy} onInput={(event) => setLegBackend(route.name, leg.nodeId, event.currentTarget.value)} /><small>Required administrator reference for this custom provider, not model detection. Changing it requires another check.</small></label>}</For>
            </details>
            <Show when={!gatewayRoutes().includes(route.name)}><button type="button" class="admin-link-button admin-danger-link" aria-label={`Remove ${route.name} stale route`} onClick={() => setPendingRemoval(route.name)}>Remove stale route</button></Show>
            <Show when={pendingRemoval() === route.name}><div class="admin-confirmation" role="alert"><strong>Remove this stale route?</strong><p>It will also be removed from draft access policies.</p><button type="button" class="admin-secondary-button" onClick={() => setPendingRemoval(undefined)}>Keep route</button><button type="button" class="admin-primary-button" aria-label={`Confirm remove ${route.name}`} onClick={() => confirmRemove(route.name)}>Confirm removal</button></div></Show>
          </div>
        </article>;
      }}</For></div>
      <details class="admin-route-reference"><summary>Known compatibility limitations</summary><For each={catalog().notices}>{(notice) => <div><strong>{notice.name}</strong><p>{notice.summary}</p><For each={notice.limitations ?? []}>{(note) => <p>{note}</p>}</For></div>}</For></details>
    </section>

    <section hidden={section() !== 'access'} class="admin-routing-pane" aria-labelledby="groups-heading">
      <div class="admin-subsection-heading"><div><h3 id="groups-heading">Group access</h3><p>Choose which checked routes each Access group can use. The first matching configured policy wins.</p></div></div>
      <Show when={unconfiguredGroups().length}><div class="admin-add-row"><label class="admin-form-field"><span>Access group</span><select aria-label="Unconfigured access group" value={groupToAdd()} onChange={(event) => setGroupToAdd(event.currentTarget.value)}><For each={unconfiguredGroups()}>{(group) => <option value={group} selected={group === groupToAdd()}>{group}</option>}</For></select></label><button type="button" class="admin-secondary-button" onClick={addGroupPolicy}>Add group policy</button></div></Show>
      <Show when={!availableAccessGroups.length}><p class="admin-status-text">Configure an Access group in Environment → Access before assigning a route.</p></Show>
      <For each={groups()}>{(group) => <section class="admin-access-policy">
        <div class="admin-policy-heading"><button type="button" class="admin-policy-toggle" aria-label={`${group.accessGroup} policy`} aria-expanded={expandedGroup() === group.accessGroup} onClick={() => setExpandedGroup(expandedGroup() === group.accessGroup ? undefined : group.accessGroup)}><strong>{group.accessGroup}</strong><span>{normalizedPolicy(group).routes.length} available routes</span></button><button type="button" class="admin-link-button admin-danger-link" aria-label={`Remove ${group.accessGroup} policy`} onClick={() => setGroups((items) => items.filter((item) => item.accessGroup !== group.accessGroup))}>Remove policy</button></div>
        <div hidden={expandedGroup() !== group.accessGroup}>
          <Show when={group.routes.some((name) => !eligibleNames().includes(name))}><p class="admin-route-scope-warning">Unchecked or unavailable routes are inactive and will not be included when you Save.</p></Show>
          <PolicyFields label={group.accessGroup} options={eligibleRoutes()} policy={normalizedPolicy(group)} levels={supportedLevels(normalizedPolicy(group).defaultRoute)} onToggle={(name) => setGroups((items) => items.map((item) => item.accessGroup === group.accessGroup ? togglePolicyRoute(item, name) : item))} onDefault={(name) => setGroups((items) => items.map((item) => item.accessGroup === group.accessGroup ? { ...normalizedPolicy(item), defaultRoute: name, reasoning: preferredLevel(name) } : item))} onReasoning={(level) => setGroups((items) => items.map((item) => item.accessGroup === group.accessGroup ? { ...normalizedPolicy(item), reasoning: level } : item))} />
        </div>
      </section>}</For>
      <Show when={groups().length > 1}><div class="admin-policy-copy"><label class="admin-form-field"><span>Copy from group</span><select aria-label="Policy source" value={applyGroupSource()} onChange={(event) => setApplyGroupSource(event.currentTarget.value)}><For each={groups()}>{(group) => <option value={group.accessGroup}>{group.accessGroup}</option>}</For></select></label><button type="button" class="admin-secondary-button" onClick={() => setApplyGroupsOpen(true)}>Apply to all groups</button></div></Show>
      <Show when={applyGroupsOpen()}><div class="admin-confirmation" role="alert"><strong>Copy one group policy</strong><p>{applyGroupSource()} will be copied to {groups().map((group) => group.accessGroup).join(', ')}.</p><button type="button" class="admin-secondary-button" onClick={() => setApplyGroupsOpen(false)}>Cancel</button><button type="button" class="admin-primary-button" onClick={copyGroupToAll}>Confirm group changes</button></div></Show>
      <section class="admin-fallback-policy" aria-labelledby="fallback-heading"><h3 id="fallback-heading">Users without a group policy</h3><p>Fallback access is for users without a matching configured group, including manually added users. When disabled, those users get no routes.</p>
        <label class="admin-toggle-field"><input type="checkbox" aria-label="Enable fallback access" checked={fallbackEnabled()} onChange={(event) => setFallbackEnabled(event.currentTarget.checked)} /><span>Enable fallback access</span></label>
        <Show when={fallbackEnabled()} fallback={<p class="admin-status-text">No fallback access</p>}><PolicyFields label="Fallback" options={eligibleRoutes()} policy={normalizedFallback()} levels={supportedLevels(normalizedFallback().defaultRoute)} onToggle={(name) => setFallbackPolicy((policy) => togglePolicyRoute(policy, name))} onDefault={(name) => setFallbackPolicy((policy) => ({ ...normalizedPolicy(policy), defaultRoute: name, reasoning: preferredLevel(name) }))} onReasoning={(level) => setFallbackPolicy((policy) => ({ ...normalizedPolicy(policy), reasoning: level }))} /></Show>
      </section>
    </section>
    <Show when={pendingProfileName()}><div class="admin-unsaved-banner" role="status"><strong>{pendingProfileName()} is a draft</strong><span>Verify it, assign a group, then confirm Save to keep the profile and assignment.</span></div></Show>
    <Show when={!checksBusy() && saveHelp()}><p class="admin-routing-save-help" role="status" data-ready={canSave()}>{saveHelp()}</p></Show>
    <For each={activeNames()}>{(name) => <input type="hidden" name="dynamicRoutes" value={name} />}</For>
    <For each={routes().filter((route) => route.assignment.activeProfile && validContext(route))}>{(route) => <><input type="hidden" name="routeContextRoute" value={route.name} /><input type="hidden" name="routeContextWindow" value={route.contextWindow} /></>}</For>
    <input type="hidden" name="defaultRoute" value={compatibilityDefault()?.defaultRoute ?? ''} /><input type="hidden" name="reasoning" value={compatibilityDefault()?.reasoning ?? 'off'} />
    <input type="hidden" name="groupRouting" value={JSON.stringify(configuredGroups())} /><input type="hidden" name="fallbackRouting" value={JSON.stringify(fallbackRouting())} /><input type="hidden" name="routeChecks" value={JSON.stringify(routeChecks())} />
    <input type="hidden" name="reasoningConfiguration" value={JSON.stringify(serializedConfiguration())} />
  </div>;
};
export default AiRoutingFields;
/* v8 ignore stop */
