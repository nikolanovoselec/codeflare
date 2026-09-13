/* v8 ignore start -- administration UI exercised by component fixtures */
import { For, Index, Show, batch, createEffect, createMemo, createSignal, onCleanup, onMount, type Component } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { checkNativeTarget, discoverNativeCompatibility, discoverReasoningCompatibility, discoverTargetCapabilities, getReasoningCatalog, getReasoningRouteInventory } from '../../api/client';
import { TargetCapabilityDiscovery, TargetCheckResult, DiscoveryCheckEvidence, CapabilityEvidence } from './TargetCapabilityDiscovery';
import { CapabilitySummarySchema } from '../../lib/schemas';
import { isGeneratedNativeProfileId } from '../../../../src/lib/reasoning-profiles';
import type { TargetDiscoveryResult } from '../../lib/target-capability-contract';
import { apiErrorMessage } from '../../api/fetch-helper';
import type {
  FallbackRouting, NativeAiTargetDraft, NativeTargetCheckResult, PiReasoningLevel, ProfileRevisionRef, ReasoningCatalog, ReasoningConfiguration,
  ReasoningDiscoveryResult, ReasoningGatewayDraft, ReasoningManagementContext, ReasoningProfileCatalogEntry,
  ReasoningRouteAssignment, ReasoningRouteInventory, ReasoningCatalogReconciliation,
} from '../../types';
import ReasoningProfileEditor, { DISCOVERY_COMPLETION_TOKENS, ReasoningCheckDetails, ReasoningCheckOverview, reasoningCheckSummary } from './ReasoningProfileEditor';
import { profileDisplayName, profileValidationBasis } from './pi-profile-presentation';
import { bedrockAnthropicCandidate, BEDROCK_MESSAGES_DEFAULT_PROFILE, nativeTargetDraftShapeValid, preservesDisabledNativeTarget } from '../../../../src/lib/native-ai-target-draft';
import '../../styles/ai-routing-workspace.css';

interface Props {
  current: unknown;
  baseRevision?: number;
  onRevisionChange?: (revision: number) => void;
  onReadyChange?: (ready: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
}
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
interface VerificationDraft { busy?: boolean; administratorConfirmed?: boolean; result?: ReasoningDiscoveryResult; error?: string; routeChanged?: boolean }
interface NativeDraft extends NativeAiTargetDraft { handle?: string; busy?: boolean; error?: string; verificationRequest?: string; rememberedRegion?: string; discoveryResult?: TargetDiscoveryResult; checkResult?: NativeTargetCheckResult }
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
// REQ-ENTERPRISE-074/078: defaults apply only to new or changed provider-model identities.
const newNativeIdentity = (provider: string, model = '', region?: string): Pick<NativeDraft, 'provider' | 'model' | 'transport' | 'region'> => {
  const nativeBedrock = provider === 'aws-bedrock' && (!model || bedrockAnthropicCandidate(model));
  return { provider, model, transport: nativeBedrock ? 'aig-bedrock-anthropic-auto' : 'aig-legacy-compat', region: nativeBedrock ? region || 'eu-central-1' : undefined };
};
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
  return result.assignable === true && (result.classification === 'Verified' || (result.classification === 'Administrator-confirmed' && result.verification?.method === 'administrator')) && Boolean(result.checkId && result.verification)
    && !result.diagnostics?.length && !result.candidateResults?.some((candidate) => candidate.diagnostics?.length);
}

interface PolicyOption { name: string; label?: string; administratorConfirmed?: boolean; observedPath?: boolean }
interface PolicyFieldsProps {
  label: string;
  options: PolicyOption[];
  policy: Pick<GroupDraft, 'routes' | 'defaultRoute' | 'reasoning'>;
  levels: PiReasoningLevel[];
  onToggle: (route: string) => void;
  onDefault: (route: string) => void;
  onReasoning: (level: PiReasoningLevel) => void;
}
const PolicyFields: Component<PolicyFieldsProps> = (props) => {
  const optionLabel = (name: string) => props.options.find((option) => option.name === name)?.label ?? name;
  return <div class="admin-policy-fields">
  <fieldset class="admin-fieldset" aria-label={`${props.label} allowed routes`}>
    <legend>Available routes</legend>
    <p class="admin-field-help">Live-verified and administrator-confirmed routes are available here.</p>
    <Show when={props.options.length} fallback={<p class="admin-status-text">Verify or confirm a profile in Dynamic routes or Native routes before assigning access.</p>}>
      <div class="admin-policy-routes"><For each={props.options}>{(route) => <label>
        <input type="checkbox" aria-label={`${props.label} ${optionLabel(route.name)} route`} checked={props.policy.routes.includes(route.name)} onChange={() => props.onToggle(route.name)} />
        <span>{optionLabel(route.name)}</span>
        <Show when={route.observedPath && !route.administratorConfirmed}><small>Backup untested</small></Show>
      </label>}</For></div>
    </Show>
  </fieldset>
  <div class="admin-route-controls">
    <label class="admin-form-field"><span>Default route</span><select aria-label={`${props.label} default route`} value={props.policy.defaultRoute} disabled={!props.policy.routes.length} onChange={(event) => props.onDefault(event.currentTarget.value)}>
      <Show when={!props.policy.routes.length}><option value="">Select an available route</option></Show>
      <For each={props.policy.routes}>{(route) => <option value={route} selected={route === props.policy.defaultRoute}>{optionLabel(route)}</option>}</For>
    </select><small>The route Pi starts with for this policy.</small></label>
    <label class="admin-form-field"><span>Default reasoning</span><select aria-label={`${props.label} default reasoning`} aria-describedby={`${encodeURIComponent(props.label)}-reasoning-help`} value={props.policy.reasoning} disabled={!props.policy.defaultRoute || (props.levels.length === 1 && props.levels[0] !== 'off')} onChange={(event) => props.onReasoning(event.currentTarget.value as PiReasoningLevel)}>
      <For each={props.levels.length ? props.levels : props.policy.defaultRoute ? LEVELS : []}>{(level) => <option value={level} selected={level === props.policy.reasoning}>{level === 'off' && props.levels.length === 0 ? 'Off (preference)' : levelLabel(level)}</option>}</For>
    </select><small id={`${encodeURIComponent(props.label)}-reasoning-help`}>{!props.policy.defaultRoute ? 'Choose an available route first.' : props.levels.length === 0 ? 'All seven preferences use Provider default: no explicit override is sent. Reasoning remains provider-controlled; Off is not guaranteed or verified.' : props.levels.length === 1 ? `This profile supports only ${levelLabel(props.levels[0])}.` : `Only options supported by this route's Pi compatibility profile are available.${props.levels.includes('off') ? '' : ' Off is not supported.'}`}</small></label>
  </div>
</div>;
};

const AiRoutingFields: Component<Props> = (props) => {
  const current = record(props.current);
  const configuration = record(current.reasoningConfiguration);
  const assignments = record(configuration.routeAssignments);
  const contextWindows = record(current.routeContextWindows);
  let storedRoutes = [...new Set([...stringList(current.dynamicRoutes), ...Object.keys(assignments)])];
  const removedSavedRoutes = new Set<string>();
  const [catalogRevision, setCatalogRevision] = createSignal(props.baseRevision);
  createEffect(() => {
    const revision = props.baseRevision;
    if (revision !== undefined) setCatalogRevision((prior) => prior === undefined ? revision : Math.max(prior, revision));
  });
  const [routeState, setRouteState] = createStore<RouteDraft[]>(storedRoutes.map((name) => ({ name, contextWindow: typeof contextWindows[name] === 'number' ? contextWindows[name] as number : DEFAULT_CONTEXT_WINDOW, assignment: routeAssignment(assignments[name]) })));
  const routes = () => routeState;
  const initialNativeDrafts: NativeDraft[] = (Array.isArray(current.nativeTargets) ? current.nativeTargets : []).flatMap((item) => {
    const target = record(item); const verification = record(target.verification); const selectedProfile = profileRef(target.profileRef);
    const discovery = CapabilitySummarySchema.safeParse(verification.discovery);
    if (!selectedProfile) return [];
    return [{ id: text(target.id) || undefined, handle: text(target.handle) || undefined, label: text(target.label), model: text(target.model),
      provider: text(target.provider) || 'aws-bedrock', contextWindow: typeof target.contextWindow === 'number' ? target.contextWindow : 200000,
      transport: target.transport === 'aig-bedrock-anthropic-invoke' || target.transport === 'aig-bedrock-anthropic-eventstream' || target.transport === 'aig-bedrock-anthropic-auto' ? target.transport : 'aig-legacy-compat',
      ...(text(target.region) && { region: text(target.region) }), profileRef: selectedProfile, enabled: target.enabled === true,
      ...(text(verification.checkedAt) && { verification: { method: verification.method === 'administrator' ? 'administrator' as const : 'automated' as const, checkedAt: text(verification.checkedAt), current: verification.current === true, ...(discovery.success && { discovery: discovery.data }) } }),
    }];
  });
  const [nativeTargets, setNativeTargets] = createSignal<NativeDraft[]>(initialNativeDrafts.map((target) => ({ ...target, enabled: target.verification?.current === true })));
  const [nativeChecks, setNativeChecks] = createSignal<Record<string, string | null>>({});
  const nativeSubmissionOf = (targets: NativeDraft[]) => targets.map(({ handle: _handle, verification: _verification, busy: _busy, error: _error, verificationRequest: _request, rememberedRegion: _region, discoveryResult: _discovery, checkResult: _check, ...target }) => target);
  const nativeSubmission = () => nativeSubmissionOf(nativeTargets());
  const [initialNativeSubmission, setInitialNativeSubmission] = createSignal(nativeSubmissionOf(initialNativeDrafts));
  const nativeDirty = () => JSON.stringify(nativeSubmission()) !== JSON.stringify(initialNativeSubmission()) || Object.keys(nativeChecks()).length > 0;
  const setRoutes = (update: (items: RouteDraft[]) => RouteDraft[]) => setRouteState(reconcile(update(routeState), { key: 'name' }));
  const updateRoute = (name: string, update: (route: RouteDraft) => RouteDraft) => setRoutes((items) => items.map((route) => route.name === name ? update(route) : route));
  const routeByName = (name: string) => routes().find((route) => route.name === name);
  const [gatewayRoutes, setGatewayRoutes] = createSignal<string[]>([]);
  const initialGatewayUrl = text(current.gatewayUrl);
  const accountApiBase = (value: string): string | undefined => {
    try {
      const url = new URL(value.trim());
      if (url.protocol !== 'https:' || url.hostname !== 'api.cloudflare.com' || url.port || url.username || url.password) return undefined;
      const match = /^\/client\/v4\/accounts\/([a-f0-9]{32})(\/.*)?$/i.exec(url.pathname);
      if (!match || !/^\/?$|^\/ai\/?$|^\/ai\/run\/?$|^\/ai\/v1(?:\/(?:chat\/completions|responses|messages|models))?\/?$/i.test(match[2] ?? '')) return undefined;
      return `https://api.cloudflare.com/client/v4/accounts/${match[1]}/`;
    } catch { return undefined; }
  };
  const legacyGatewayId = (value: string): string => /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[^/]+\/([^/?#]+)/i.exec(value.trim())?.[1] ?? '';
  const [gatewayKind, setGatewayKind] = createSignal<'legacy' | 'account-api'>(accountApiBase(initialGatewayUrl) ? 'account-api' : 'legacy');
  const [gatewayUrl, setGatewayUrl] = createSignal(initialGatewayUrl);
  const [gatewayId, setGatewayId] = createSignal(text(current.gatewayId) || legacyGatewayId(initialGatewayUrl));
  const [replacementToken, setReplacementToken] = createSignal(text(current.replacementToken));
  const [checkedConnection, setCheckedConnection] = createSignal<string>();
  const effectiveGatewayUrl = () => gatewayKind() === 'account-api' ? accountApiBase(gatewayUrl()) ?? gatewayUrl().trim() : gatewayUrl().trim();
  const effectiveGatewayId = () => gatewayKind() === 'account-api' ? gatewayId().trim() : '';
  const connectionKey = () => JSON.stringify([effectiveGatewayUrl(), effectiveGatewayId() || legacyGatewayId(gatewayUrl()), replacementToken().trim()]);
  const gatewayDraft = (): ReasoningGatewayDraft | undefined => effectiveGatewayUrl() !== text(current.savedGatewayUrl ?? current.gatewayUrl).trim() || effectiveGatewayId() !== (gatewayKind() === 'account-api' ? text(current.gatewayId).trim() : '') || replacementToken().trim()
    ? { gatewayUrl: effectiveGatewayUrl(), ...(effectiveGatewayId() && { gatewayId: effectiveGatewayId() }), ...(replacementToken().trim() && { replacementToken: replacementToken().trim() }) } : undefined;
  const connectionDraft = () => gatewayDraft() !== undefined;
  const [catalog, setCatalog] = createSignal<ReasoningCatalog>({ schemaVersion: 1, profiles: [], notices: [], usage: [], routes: [], routeCatalogStatus: 'unavailable' });
  const [catalogBusy, setCatalogBusy] = createSignal(true);
  const [catalogError, setCatalogError] = createSignal('');
  const connectionReady = () => !catalogBusy() && !catalogError() && catalog().routeCatalogStatus === 'ready' && checkedConnection() === connectionKey();
  const [section, setSection] = createSignal<'connection' | 'routes' | 'native' | 'access'>('routes');
  const [expandedRoute, setExpandedRoute] = createSignal<string>();
  const [expandedNative, setExpandedNative] = createSignal<number>();
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
  const [nativeProfileEditor, setNativeProfileEditor] = createSignal<number>();
  const [profileEditorBusy, setProfileEditorBusy] = createSignal(false);
  const [capabilityResults, setCapabilityResults] = createSignal<Record<string, TargetDiscoveryResult | undefined>>({});
  const [discoveringTarget, setDiscoveringTarget] = createSignal<string>();
  const [pendingProfileName, setPendingProfileName] = createSignal('');
  const [unavailableRouteProfiles, setUnavailableRouteProfiles] = createSignal<Record<string, string>>({});
  const [pendingRemoval, setPendingRemoval] = createSignal<string>();
  const [applyGroupsOpen, setApplyGroupsOpen] = createSignal(false);
  const [applyGroupSource, setApplyGroupSource] = createSignal(groups()[0]?.accessGroup ?? '');
  const [verifications, setVerifications] = createSignal<Record<string, VerificationDraft>>({});
  const verificationFor = (name: string): VerificationDraft => verifications()[name] ?? {};
  const updateVerification = (name: string, update: VerificationDraft) => setVerifications((items) => ({ ...items, [name]: update }));
  const checksBusy = () => profileEditorBusy() || Object.values(verifications()).some((value) => value.busy) || nativeTargets().some((target) => target.busy);
  // REQ-ENTERPRISE-044: compare editable semantics, not inventory-driven policy normalization.
  const routeDraftEntry = (route: RouteDraft) => ({ name: route.name, contextWindow: route.contextWindow, assignment: route.assignment });
  const routeDraft = () => routes().filter((route) => storedRoutes.includes(route.name) || route.assignment.activeProfile || route.contextWindow !== DEFAULT_CONTEXT_WINDOW)
    .map(routeDraftEntry).sort((a, b) => a.name.localeCompare(b.name));
  const draftSnapshot = () => ({
    gatewayUrl: effectiveGatewayUrl(), gatewayId: effectiveGatewayId(), replacementToken: replacementToken().trim(),
    routes: routeDraft(),
    groups: groups().map((group) => ({ ...group, routes: [...group.routes] })),
    fallback: (fallbackEnabled() ? { enabled: true, ...fallbackPolicy(), routes: [...fallbackPolicy().routes] } : { enabled: false }) as FallbackRouting,
    customRevisions: customRevisions(),
    nativeTargets: nativeSubmission(),
  });
  const initialRouteDraftKeys = new Map(routeDraft().map((route) => [route.name, JSON.stringify(route)]));
  const draftKey = (draft = draftSnapshot()) => JSON.stringify({ ...draft,
    groups: draft.groups.map((group) => ({ ...group, routes: [...group.routes].sort() })),
    fallback: draft.fallback.enabled ? { ...draft.fallback, routes: [...draft.fallback.routes].sort() } : draft.fallback,
  });
  const [initialDraft, setInitialDraft] = createSignal(JSON.parse(JSON.stringify(draftSnapshot())) as ReturnType<typeof draftSnapshot>);
  createEffect(() => props.onDirtyChange?.(draftKey() !== draftKey(initialDraft())));
  let disposed = false;
  onCleanup(() => { disposed = true; });

  const assignableProfiles = createMemo(() => [...catalog().profiles, ...customRevisions()
    .filter((revision) => !catalog().profiles.some((profile) => profile.id === revision.id && profile.revision === revision.revision))
    .flatMap((revision): ReasoningProfileCatalogEntry[] => {
      const ref = profileRef(revision);
      return ref ? [{ ...revision, ...ref, name: text(revision.name), enabled: revision.enabled !== false, supportedLevels: stringList(revision.supportedLevels).filter(isLevel) }] : [];
    })].filter((profile) => profile.enabled !== false && profile.assignable !== false));
  const dynamicRouteProfiles = createMemo(() => assignableProfiles().filter((profile) => !profile.id.startsWith('bedrock-anthropic-native-')));
  const findProfile = (ref?: ProfileRevisionRef) => assignableProfiles().find((profile) => refKey(profile) === refKey(ref));
  const configuredProviders = createMemo(() => (catalog().providers ?? []).filter((provider) => provider.configured));
  const selectableProviders = createMemo(() => configuredProviders().filter((provider) => provider.supported));
  const providerLabel = (provider: string) => provider === 'aws-bedrock' ? 'AWS Bedrock'
    : configuredProviders().find((candidate) => candidate.provider === provider)?.label ?? provider;
  const nativeReady = (target: NativeDraft) => target.enabled && target.verification?.current === true && Boolean(target.handle || target.id)
    && Number.isSafeInteger(target.contextWindow) && target.contextWindow > 16384;
  const preparedProfileId = (provider: string) => provider === 'aws-bedrock' ? 'bedrock-anthropic-compat'
    : provider === 'google-ai-studio' ? 'native-google-ai-studio-compat'
      : provider === 'openai' ? 'native-openai-compat' : 'native-codeflare-inference-mesh-compat';
  const nativeProfileId = (target: Pick<NativeDraft, 'provider' | 'model' | 'transport'>): string => {
    if (target.provider !== 'aws-bedrock' || !target.transport || target.transport === 'aig-legacy-compat') return preparedProfileId(target.provider);
    return BEDROCK_MESSAGES_DEFAULT_PROFILE;
  };
  const nativePreparedProfileRef = (target: Pick<NativeDraft, 'provider' | 'model' | 'transport'>): ProfileRevisionRef | undefined => {
    const profile = assignableProfiles().find((candidate) => candidate.id === nativeProfileId(target));
    return profile ? profileRefFromEntry(profile) : undefined;
  };
  const profilesForTarget = (target: NativeDraft) => {
    // Discovery changes the selected ref, not the saved target's Advanced choices.
    // A changed model/provider/transport does not inherit that historical choice.
    const saved = initialNativeDrafts.find((prior) => target.id && prior.id === target.id
      && prior.provider === target.provider && prior.model === target.model
      && prior.transport === target.transport && prior.region === target.region);
    return assignableProfiles().filter((profile) => target.transport && target.transport !== 'aig-legacy-compat'
      ? profile.id === nativeProfileId(target) || profile.id === target.profileRef.id || profile.id === saved?.profileRef.id
      : !profile.id.startsWith('bedrock-anthropic-native-'));
  };
  const supportedLevels = (name: string) => {
    if (name.startsWith('cf-native-')) return findProfile(nativeTargets().find((target) => nativeHandle(target) === name)?.profileRef)?.supportedLevels ?? [];
    return findProfile(routeByName(name)?.assignment.activeProfile)?.supportedLevels ?? [];
  };
  const preferredLevel = (name: string): PiReasoningLevel => {
    const levels = supportedLevels(name);
    return levels.includes('medium') ? 'medium' : levels.includes('off') ? 'off' : levels[0] ?? 'off';
  };
  const validContext = (route: RouteDraft) => Number.isSafeInteger(route.contextWindow) && route.contextWindow > 0;
  const verifiedAssignment = (route: RouteDraft): boolean => {
    const proof = route.assignment.verification;
    const inventory = route.inventory;
    const profile = findProfile(route.assignment.activeProfile);
    if ((!connectionReady() && !connectionDraft()) || !profile || !proof || !inventory || route.inventoryBusy || route.inventoryError || verificationFor(route.name).busy) return false;
    if (!inventory.inventoryDigest || proof.inventoryDigest !== inventory.inventoryDigest || proof.routeVersion !== inventoryVersion(inventory)
      || refKey(proof.profileRef) !== refKey(route.assignment.activeProfile) || !profile.supportedLevels.every((level) => proof.supportedLevels?.includes(level))) return false;
    if (routeChecks()[route.name] === null) return false;
    if (!gatewayDraft() && !routeChecks()[route.name] && (!inventory.verification || inventory.verification.connectionFingerprint !== proof.connectionFingerprint
      || inventory.verification.inventoryDigest !== proof.inventoryDigest || refKey(inventory.verification.profileRef) !== refKey(proof.profileRef))) return false;
    return proof.scope === 'observed-path' || (proof.scope === 'single-model' && inventory.legs.length === 1);
  };
  const eligibleRoutes = createMemo(() => routes().filter((route) => gatewayRoutes().includes(route.name) && verifiedAssignment(route) && validContext(route)));
  const nativeHandle = (target: NativeDraft) => target.handle ?? (target.id ? `cf-native-${target.id}` : '');
  const eligibleNativeTargets = createMemo(() => nativeTargets().filter((target) => target.enabled && target.verification?.current && nativeHandle(target) && Number.isSafeInteger(target.contextWindow) && target.contextWindow > 16384));
  const nativeModelSuggestions = (provider: string) => [...new Set(routes().flatMap((route) => route.inventory?.legs
    .filter((leg) => leg.provider.replace(/^custom-/, '') === provider).map((leg) => leg.declaredModel) ?? []))].sort();
  const eligiblePolicyOptions = createMemo<PolicyOption[]>(() => [
    ...eligibleRoutes().map((route) => ({ name: route.name, label: `Dynamic Route - ${route.name}`, administratorConfirmed: route.assignment.verification?.method === 'administrator', observedPath: route.assignment.verification?.scope === 'observed-path' })),
    ...eligibleNativeTargets().map((target) => ({ name: nativeHandle(target), label: `Native Route - ${providerLabel(target.provider)} - ${target.label.trim() || target.model}`, administratorConfirmed: target.verification?.method === 'administrator' })),
  ]);
  const eligibleNames = () => eligiblePolicyOptions().map((route) => route.name);
  const normalizedPolicy = <T extends Pick<GroupDraft, 'routes' | 'defaultRoute' | 'reasoning'>>(policy: T): T => {
    const selected = policy.routes.filter((name) => eligibleNames().includes(name));
    const defaultRoute = selected.includes(policy.defaultRoute) ? policy.defaultRoute : selected[0] ?? '';
    const levels = supportedLevels(defaultRoute);
    const reasoning = defaultRoute && defaultRoute === policy.defaultRoute && (levels.length === 0 || levels.includes(policy.reasoning)) ? policy.reasoning : preferredLevel(defaultRoute);
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
  const nativeConfigurationReady = () => nativeDirty() && nativeSubmission().every((target) => nativeTargetDraftShapeValid(target)
    && (Boolean(findProfile(target.profileRef)) || preservesDisabledNativeTarget(target, initialNativeDrafts.find((prior) => prior.id === target.id))));
  const verifiedRouteConfigurationReady = () => eligibleRoutes().some((route) => JSON.stringify(routeDraftEntry(route)) !== initialRouteDraftKeys.get(route.name))
    && (!nativeDirty() || nativeConfigurationReady());
  const canSave = () => connectionReady() && !policyInventoryPending() && !checksBusy()
    && (!fallbackEnabled() || normalizedFallback().routes.length > 0)
    && (activeGroups().length > 0 || normalizedFallback().routes.length > 0 || gatewayDraft() !== undefined || nativeConfigurationReady()
      || verifiedRouteConfigurationReady());
  const saveHelp = () => !connectionReady() ? 'Check the AI Gateway connection before saving.' : policyInventoryPending() ? 'Wait for selected route models to finish loading.' : checksBusy() ? 'Wait for the current profile check to finish.' : fallbackEnabled() && !normalizedFallback().routes.length ? 'Choose an available route for fallback access, or turn fallback off.' : '';
  createEffect(() => props.onReadyChange?.(canSave()));

  const clearRouteVerification = (name: string) => {
    setCapabilityResults((items) => ({ ...items, [name]: undefined }));
    setRouteChecks((checks) => ({ ...checks, [name]: null }));
    updateVerification(name, {});
    updateRoute(name, (route) => ({ ...route, assignment: { ...route.assignment, verification: undefined, commonMapping: undefined,
      ...(route.assignment.legs && { legs: route.assignment.legs.map((leg) => ({ ...leg, ...(leg.evidence && { evidence: { ...leg.evidence, current: false, status: 'stale' } }) })) }),
    } }));
  };
  const changeConnection = (field: 'kind' | 'url' | 'gateway' | 'token', value: string) => {
    if (field === 'kind') setGatewayKind(value as 'legacy' | 'account-api');
    else if (field === 'url') setGatewayUrl(value);
    else if (field === 'gateway') setGatewayId(value);
    else setReplacementToken(value);
    setCheckedConnection(undefined);
    for (const route of routes()) updateRoute(route.name, (draft) => ({ ...draft, inventory: undefined, inventoryBusy: false, inventoryError: undefined }));
    // Saved route and native authority remain draft inputs while connection changes are checked.
    // Preview revalidates it against the resolved gateway and provider configuration before Save.
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
  // REQ-ENTERPRISE-034/044/052: only server-applied removals change retained
  // draft references. A missing route/provider in a read is not deletion proof.
  const reconcileSavedDraft = (result: ReasoningCatalogReconciliation) => {
    if (result.status !== 'applied') return;
    const removedRoutes = new Set(result.removedDynamicRoutes);
    const removedIds = new Set(result.removedNativeTargetIds);
    const removedNames = new Set([...removedRoutes, ...result.removedNativeTargetIds.map((id) => `cf-native-${id}`),
      ...nativeTargets().filter((target) => target.id && removedIds.has(target.id)).map(nativeHandle)]);
    const prunePolicy = <T extends Pick<GroupDraft, 'routes' | 'defaultRoute' | 'reasoning'>>(policy: T): T => {
      const routes = policy.routes.filter((name) => !removedNames.has(name));
      if (routes.length === policy.routes.length && !removedNames.has(policy.defaultRoute)) return policy;
      const defaultRoute = routes.includes(policy.defaultRoute) ? policy.defaultRoute : routes[0] ?? '';
      return { ...policy, routes, defaultRoute, reasoning: defaultRoute === policy.defaultRoute ? policy.reasoning : preferredLevel(defaultRoute) };
    };
    const pruneFallback = (policy: FallbackRouting): FallbackRouting => {
      if (!policy.enabled) return policy;
      const next = prunePolicy(policy);
      return policy.routes.length > 0 && next.routes.length === 0 ? { enabled: false } : next;
    };
    batch(() => {
      for (const name of removedRoutes) { removedSavedRoutes.add(name); initialRouteDraftKeys.delete(name); }
      storedRoutes = storedRoutes.filter((name) => !removedRoutes.has(name));
      setRoutes((items) => items.filter((route) => !removedRoutes.has(route.name)));
      setNativeTargets((items) => items.filter((target) => !target.id || !removedIds.has(target.id)));
      setInitialNativeSubmission((items) => items.filter((target) => !target.id || !removedIds.has(target.id)));
      setGroups((items) => items.map(prunePolicy));
      const nextFallback = pruneFallback(fallbackEnabled() ? { enabled: true, ...fallbackPolicy() } : { enabled: false });
      setFallbackPolicy(prunePolicy);
      setFallbackEnabled(nextFallback.enabled);
      setRouteChecks((items) => Object.fromEntries(Object.entries(items).filter(([name]) => !removedRoutes.has(name))));
      setNativeChecks((items) => Object.fromEntries(Object.entries(items).filter(([id]) => !removedIds.has(id))));
      setVerifications((items) => Object.fromEntries(Object.entries(items).filter(([name]) => !removedRoutes.has(name))));
      setCapabilityResults((items) => Object.fromEntries(Object.entries(items).filter(([name]) => !removedRoutes.has(name))));
      setInitialDraft((draft) => ({ ...draft,
        routes: draft.routes.filter((route) => !removedRoutes.has(route.name)),
        nativeTargets: draft.nativeTargets.filter((target) => !target.id || !removedIds.has(target.id)),
        groups: draft.groups.map(prunePolicy), fallback: pruneFallback(draft.fallback),
      }));
      if (expandedRoute() && removedRoutes.has(expandedRoute()!)) setExpandedRoute(undefined);
      if (profileEditorRoute() && removedRoutes.has(profileEditorRoute()!)) setProfileEditorRoute(undefined);
      if (removedIds.size) { setExpandedNative(undefined); setNativeProfileEditor(undefined); }
    });
  };
  const checkConnection = async () => {
    if (gatewayKind() === 'account-api') {
      const canonical = accountApiBase(gatewayUrl());
      if (canonical) setGatewayUrl(canonical);
    }
    setCatalogBusy(true); setCatalogError('');
    const key = connectionKey();
    try {
      const gateway = gatewayDraft();
      const baseRevision = catalogRevision();
      const loaded = gateway ? await getReasoningCatalog(gateway)
        : baseRevision === undefined ? await getReasoningCatalog()
          : await getReasoningCatalog(undefined, { reconcileSaved: true, baseRevision });
      if (disposed) return;
      // The POST may have committed while the operator edited connection fields.
      // Rebase its authoritative removals, but do not display the stale inventory.
      if (!gateway && loaded.reconciliation && (catalogRevision() === undefined || loaded.reconciliation.revision >= catalogRevision()!)) {
        reconcileSavedDraft(loaded.reconciliation);
        setCatalogRevision(loaded.reconciliation.revision);
        props.onRevisionChange?.(loaded.reconciliation.revision);
      }
      if (key !== connectionKey()) return;
      setCatalog(loaded);
      if (loaded.routeCatalogStatus === 'ready') {
        setCheckedConnection(key); setGatewayRoutes(loaded.routes);
        const providerNativeRefs = new Map(loaded.profiles.filter((profile) => profile.id.startsWith('bedrock-anthropic-native-')).map((profile) => [refKey(profile), profileDisplayName(profile)]));
        const unavailable: Record<string, string> = {};
        setRoutes((items) => {
          const byName = new Map(items.map((route) => [route.name, route]));
          const loadedRoutes = loaded.routes.map((name) => byName.has(name) ? { ...byName.get(name)!, inventoryBusy: true } : { name, contextWindow: DEFAULT_CONTEXT_WINDOW, assignment: routeAssignment(removedSavedRoutes.has(name) ? undefined : assignments[name]), inventoryBusy: true });
          for (const route of loadedRoutes) {
            const label = providerNativeRefs.get(refKey(route.assignment.activeProfile));
            if (label) { unavailable[route.name] = label; route.assignment = {}; }
          }
          return [...loadedRoutes, ...items.filter((route) => !loaded.routes.includes(route.name)).map((route) => ({ ...route }))];
        });
        setUnavailableRouteProfiles(unavailable);
      } else setCheckedConnection(undefined);
    } catch {
      if (!disposed) { setCheckedConnection(undefined); setCatalogError('The connection could not be checked. Try again.'); }
    } finally { if (!disposed) setCatalogBusy(false); }
    if (connectionReady()) for (const name of gatewayRoutes()) { if (disposed) break; await inspect(name); }
  };
  onMount(() => { void checkConnection(); });

  const setRouteProfile = (name: string, key: string) => {
    const selected = dynamicRouteProfiles().find((profile) => refKey(profile) === key);
    setUnavailableRouteProfiles((items) => Object.fromEntries(Object.entries(items).filter(([route]) => route !== name)));
    clearRouteVerification(name);
    updateRoute(name, (route) => ({ ...route, assignment: { ...route.assignment, activeProfile: selected ? profileRefFromEntry(selected) : undefined,
      ...(route.assignment.legs && { legs: route.assignment.legs.map((leg) => ({ ...leg, ...(selected && { profileRef: profileRefFromEntry(selected) }) })) }),
    } }));
  };
  const adoptContract = (result: TargetDiscoveryResult) => {
    const profile = result.profile;
    if (!profile || profile.builtIn) return;
    setCustomRevisions((items) => items.some((item) => refKey(profileRef(item)) === refKey(profile)) ? items : [...items, profile as unknown as Record<string, unknown>]);
  };
  const discoverRoute = async (name: string) => {
    if (!connectionReady() || checksBusy() || !gatewayRoutes().includes(name)) return;
    const connection = connectionKey();
    const selected = refKey(routeByName(name)?.assignment.activeProfile);
    clearRouteVerification(name); updateVerification(name, { busy: true }); setDiscoveringTarget(name);
    try {
      const before = await inspect(name);
      if (!before?.inventoryDigest) throw new Error('inventory_unavailable');
      const result = await discoverTargetCapabilities({ kind: 'dynamic-route', route: name, ...managementContext(name) });
      if (disposed) return;
      const after = await inspect(name);
      if (connection !== connectionKey() || selected !== refKey(routeByName(name)?.assignment.activeProfile)) return;
      if (!after || before.inventoryDigest !== after.inventoryDigest || result.routeVerification && result.routeVerification.inventoryDigest !== after.inventoryDigest) {
        updateVerification(name, { routeChanged: true }); return;
      }
      setCapabilityResults((items) => ({ ...items, [name]: result }));
      if (!result.assignable || !result.profile || !result.checkId || !result.routeVerification) return;
      adoptContract(result);
      const selectedRef = profileRefFromEntry(result.profile);
      setRouteChecks((items) => ({ ...items, [name]: result.checkId! }));
      updateRoute(name, (route) => ({ ...route, assignment: { ...route.assignment, activeProfile: selectedRef,
        commonMapping: undefined, routeVersion: result.routeVerification!.routeVersion, verification: result.routeVerification,
        ...(route.assignment.legs && { legs: after.legs.map((leg) => ({ nodeId: leg.nodeId, provider: leg.provider,
          declaredModel: leg.declaredModel, profileRef: selectedRef, ...(leg.customProviderBackend && { customProviderBackend: leg.customProviderBackend }) })) }) } }));
    } catch (error) {
      if (!disposed) updateVerification(name, { error: apiErrorMessage(error, 'Discovery did not establish the required tool lifecycle. Nothing was enabled.') });
    } finally {
      setDiscoveringTarget(undefined);
      if (!disposed) setVerifications((items) => ({ ...items, [name]: { ...items[name], busy: false } }));
    }
  };
  const discoverNative = async (index: number) => {
    const target = nativeTargets()[index];
    if (!target || target.provider !== 'aws-bedrock' || !connectionReady() || checksBusy()) return;
    const connection = connectionKey();
    const requestId = crypto.randomUUID();
    const key = `native-${index}`;
    setDiscoveringTarget(key);
    if (target.id) setNativeChecks((items) => ({ ...items, [target.id!]: null }));
    setNativeTargets((items) => items.map((item, at) => at === index ? { ...item, busy: true, enabled: false, verification: undefined, verificationRequest: requestId, error: undefined, discoveryResult: undefined, checkResult: undefined } : item));
    try {
      const result = await discoverTargetCapabilities({ kind: 'native-provider', target: { ...nativeSubmission()[index], enabled: false }, ...(gatewayDraft() && { gateway: gatewayDraft()! }) });
      if (disposed || connection !== connectionKey() || !nativeTargets().some((item) => item.verificationRequest === requestId)) return;
      // Bind the display result to the same draft object as its receipt. Array
      // indexes can move if another row is removed while discovery is running.
      setNativeTargets((items) => items.map((item) => item.verificationRequest === requestId ? { ...item, discoveryResult: result } : item));
      if (!result.assignable || !result.profile || !result.checkId || !result.targetId || !result.nativeVerification) return;
      adoptContract(result);
      setNativeChecks((items) => ({ ...items, [result.targetId!]: result.checkId! }));
      setNativeTargets((items) => items.map((item) => item.verificationRequest === requestId ? { ...item,
        id: result.targetId, handle: `cf-native-${result.targetId}`, profileRef: profileRefFromEntry(result.profile!),
        verification: result.nativeVerification, enabled: true } : item));
    } catch (error) {
      if (!disposed) setNativeTargets((items) => items.map((item) => item.verificationRequest === requestId
        ? { ...item, error: apiErrorMessage(error, 'Discovery did not establish the required tool lifecycle. Nothing was enabled.') } : item));
    } finally {
      setDiscoveringTarget(undefined);
      if (!disposed) setNativeTargets((items) => items.map((item) => item.verificationRequest === requestId ? { ...item, busy: false, verificationRequest: undefined } : item));
    }
  };
  const verifySelectedProfile = async (name: string, administratorConfirmed = false) => {
    const route = routeByName(name);
    if (!route?.assignment.activeProfile || !findProfile(route.assignment.activeProfile) || !connectionReady() || verificationFor(name).busy) return;
    const selectedRef = { ...route.assignment.activeProfile };
    const profileDraft = customRevisions().find((profile) => refKey(profileRef(profile)) === refKey(selectedRef) && !catalog().profiles.some((saved) => refKey(saved) === refKey(selectedRef)));
    const connection = connectionKey();
    clearRouteVerification(name); updateVerification(name, { busy: true, administratorConfirmed });
    try {
      const before = await inspect(name);
      if (!before?.inventoryDigest) throw new Error('inventory_unavailable');
      const result = await discoverReasoningCompatibility({ route: name, profileRef: selectedRef, ...(administratorConfirmed && { administratorConfirmed: true as const }), ...(profileDraft && { profileDraft }), ...managementContext(name), maxCompletionTokens: DISCOVERY_COMPLETION_TOKENS });
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
      if (!disposed) updateVerification(name, { error: administratorConfirmed ? 'Confirmation failed. Check the connection and try again.' : 'Verification failed. Check the connection and try again.' });
    }
  };
  const verifyNativeTarget = async (index: number, administratorConfirmed = false) => {
    const original = nativeTargets()[index];
    if (!original || original.busy || !connectionReady() || !findProfile(original.profileRef)) return;
    const target = { ...original, enabled: false, verification: undefined, discoveryResult: undefined, checkResult: undefined };
    if (target.id) setNativeChecks((checks) => ({ ...checks, [target.id!]: null }));
    const requestId = crypto.randomUUID();
    const profileDraft = customRevisions().find((profile) => refKey(profileRef(profile)) === refKey(target.profileRef)
      && !catalog().profiles.some((saved) => refKey(saved) === refKey(target.profileRef)));
    setNativeTargets((items) => items.map((item, at) => at === index ? { ...target, busy: true, error: undefined, verificationRequest: requestId } : item));
    try {
      const result = await checkNativeTarget({ target: { ...(target.id && { id: target.id }), label: target.label, model: target.model, provider: target.provider,
        contextWindow: target.contextWindow, transport: target.transport ?? 'aig-legacy-compat', ...(target.region && { region: target.region }), profileRef: target.profileRef, enabled: false }, ...(profileDraft && { profileDraft }),
        ...(administratorConfirmed && { administratorConfirmed: true as const }), ...(gatewayDraft() && { gateway: gatewayDraft()! }) });
      if (disposed || !nativeTargets().some((item) => item.verificationRequest === requestId)) return;
      setNativeTargets((items) => items.map((item) => item.verificationRequest === requestId ? { ...item, checkResult: result } : item));
      if (!result.assignable || !result.checkId || !result.verification) {
        setNativeTargets((items) => items.map((item) => item.verificationRequest === requestId ? { ...item, busy: false, enabled: false, verification: undefined, verificationRequest: undefined } : item));
        return;
      }
      setNativeChecks((checks) => ({ ...checks, [result.targetId]: result.checkId }));
      setNativeTargets((items) => items.map((item) => item.verificationRequest === requestId ? { ...item, id: result.targetId, handle: `cf-native-${result.targetId}`, busy: false, enabled: result.verification?.current === true, verification: result.verification, verificationRequest: undefined } : item));
    } catch (error) {
      const message = apiErrorMessage(error, 'Target check failed. Check the exact model, provider readiness, and connection.');
      setNativeTargets((items) => items.map((item) => item.verificationRequest === requestId ? { ...item, busy: false, enabled: false, verification: undefined, verificationRequest: undefined, error: message } : item));
    }
  };

  const routeStatus = (route: RouteDraft): { label: string; state: 'passed' | 'failed' | 'unclear' } => {
    const check = verificationFor(route.name);
    if (profileEditorRoute() === route.name && profileEditorBusy()) return { label: 'Discovering…', state: 'unclear' };
    if (check.busy) return { label: check.administratorConfirmed ? 'Confirming…' : 'Verifying…', state: 'unclear' };
    if (check.error || check.result?.classification === 'Unsupported') return { label: 'Check failed · inactive', state: 'failed' };
    if (!route.assignment.activeProfile) return { label: 'Discover capabilities', state: 'unclear' };
    if (verifiedAssignment(route)) return !validContext(route) ? { label: 'Set context window', state: 'unclear' } : route.assignment.verification?.method === 'administrator' ? { label: 'Administrator-confirmed', state: 'passed' } : route.assignment.verification?.scope === 'observed-path' ? { label: 'Compatible · backup untested', state: 'passed' } : { label: 'Verified', state: 'passed' };
    return { label: 'Needs confirmation · inactive', state: 'unclear' };
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
    } satisfies ReasoningRouteAssignment]] : [])),
  }));
  const submittedGroups = () => connectionDraft() ? groups() : configuredGroups();
  const submittedFallback = (): FallbackRouting => connectionDraft()
    ? fallbackEnabled() ? { enabled: true, ...fallbackPolicy() } : { enabled: false }
    : fallbackRouting();
  const submittedNames = () => {
    if (!connectionDraft()) return activeNames().filter((name) => gatewayRoutes().includes(name));
    const nativeNames = new Set(nativeTargets().map(nativeHandle).filter(Boolean));
    return [...new Set([...groups().flatMap((group) => group.routes), ...(fallbackEnabled() ? fallbackPolicy().routes : [])])]
      .filter((name) => !nativeNames.has(name));
  };
  const compatibilityDefault = () => connectionDraft()
    ? fallbackEnabled() && fallbackPolicy().routes.length ? fallbackPolicy() : groups().find((group) => group.routes.length > 0)
    : fallbackEnabled() && normalizedFallback().routes.length ? normalizedFallback() : activeGroups()[0];

  return <div class="admin-ai-routing admin-form-wide admin-routing-workspace">
    <div class="admin-routing-intro"><h3>Discover capabilities, then grant access</h3><p>Configure a target → Discover → Check result → Review changes → Confirm Save. Discover selects and verifies automatically; saved changes apply at the next normal session start.</p></div>
    <section class="admin-connection-status" aria-label="AI Gateway connection status" data-state={connectionReady() ? 'passed' : catalogBusy() ? 'unclear' : 'failed'}>
      <div><strong>AI Gateway</strong><span role="status">{catalogBusy() ? 'Checking connection…' : connectionReady() ? `Connected · ${gatewayRoutes().length} routes readable` : checkedConnection() !== connectionKey() && catalog().routeCatalogStatus === 'ready' ? 'Connection changed · check required' : 'Connection needs attention'}</span></div>
      <Show when={!connectionReady() && !catalogBusy()}><p role="alert">{catalogError() || (catalog().routeCatalogStatus === 'ready' ? 'Check the edited connection before verifying routes.' : catalog().connection?.message) || 'Routes could not be read. Check the gateway URL, token, and AI Gateway Read permission.'}</p></Show>
    </section>
    <nav class="admin-routing-nav" aria-label="AI Gateway configuration sections">
      <button type="button" aria-pressed={section() === 'connection'} onClick={() => setSection('connection')}>Connection</button>
      <button type="button" aria-pressed={section() === 'routes'} onClick={() => setSection('routes')}>Dynamic routes</button>
      <button type="button" aria-pressed={section() === 'native'} onClick={() => setSection('native')}>Native routes</button>
      <button type="button" aria-pressed={section() === 'access'} onClick={() => setSection('access')}>Access &amp; fallback</button>
    </nav>

    <section hidden={section() !== 'connection'} class="admin-routing-pane" aria-labelledby="connection-heading">
      <h3 id="connection-heading">AI Gateway connection</h3><p>Check that Codeflare can read your routes. Then select a target and use Discover to verify its tools, cache reuse, reasoning and delivery.</p>
      <div class="admin-route-controls admin-connection-fields">
        <label class="admin-form-field admin-connection-format"><span>Gateway URL format</span><select aria-label="Gateway URL format" value={gatewayKind()} disabled={checksBusy()} onChange={(event) => changeConnection('kind', event.currentTarget.value)}><option value="account-api">Account API (v4)</option><option value="legacy">Legacy gateway URL (v1)</option></select></label>
        <label class="admin-form-field admin-connection-url"><span>AI Gateway URL</span><input aria-label="AI Gateway URL" name="gatewayUrl" type="url" value={gatewayUrl()} disabled={checksBusy()} onInput={(event) => changeConnection('url', event.currentTarget.value)} /><small>{gatewayKind() === 'account-api' ? 'Paste any account API URL. Codeflare keeps only the URL through the account ID.' : 'Use the full legacy URL including account ID and gateway name.'}</small></label>
        <Show when={gatewayKind() === 'account-api'}><label class="admin-form-field admin-connection-name"><span>AI Gateway name</span><input aria-label="AI Gateway name" name="gatewayId" value={gatewayId()} disabled={checksBusy()} onInput={(event) => changeConnection('gateway', event.currentTarget.value)} /><small>Used for Dynamic Route discovery and the cf-aig-gateway-id request header.</small></label></Show>

        <label class="admin-form-field admin-connection-token"><span>Replacement API token</span><input aria-label="Replacement API token" name="replacementToken" type="password" value={replacementToken()} autocomplete="new-password" disabled={checksBusy()} onInput={(event) => changeConnection('token', event.currentTarget.value)} /><small>Leave blank to keep the saved token. Token permissions must allow route reads and gateway requests.</small></label>
      </div>
      <button type="button" class="admin-secondary-button" disabled={catalogBusy() || checksBusy()} onClick={() => void checkConnection()}>Check connection</button>
      <p class="admin-field-help">Connection checks do not save credentials or run paid model probes.</p>
    </section>

    <section hidden={section() !== 'routes'} class="admin-routing-pane" aria-labelledby="routes-heading">
      <div class="admin-subsection-heading"><div><h3 id="routes-heading">Dynamic routes</h3><p>Choose a route to configure it. A Pi compatibility profile translates Pi requests for tool calling and reasoning before AI Gateway selects a backend.</p></div><span class="admin-status">{eligibleRoutes().length} ready / {routes().length} routes</span></div>
      <Show when={!catalogBusy() && routes().length === 0}><p class="admin-status-text">No routes available. Create a dynamic route in AI Gateway, then check the connection again.</p></Show>
      <div class="admin-route-overview"><For each={routes()}>{(route) => {
        const profile = () => findProfile(route.assignment.activeProfile);
        const check = () => verificationFor(route.name);
        const evidence = () => route.assignment.verification?.capabilities ?? check().result?.capabilitySummary;
        const legs = () => route.inventory?.legs ?? [];
        return <article class="admin-route-entry" aria-label={`${route.name} route`}>
          <button type="button" class="admin-route-toggle" aria-label={`Configure ${route.name}`} aria-expanded={expandedRoute() === route.name} aria-controls={`route-panel-${encodeURIComponent(route.name)}`} onClick={() => setExpandedRoute(expandedRoute() === route.name ? undefined : route.name)}>
            <span><strong>Dynamic Route - {route.name}</strong><small>{activeNames().includes(route.name) ? 'Assigned to access policy' : 'Not active in a policy'}</small></span>
            <span class="admin-check-pill" data-state={routeStatus(route).state}>{routeStatus(route).label}</span><span class="admin-route-chevron" aria-hidden="true">›</span>
          </button>
          <div hidden={expandedRoute() !== route.name} id={`route-panel-${encodeURIComponent(route.name)}`} class="admin-route-panel">
            <section class="admin-route-models" aria-label={`${route.name} detected models`}><div class="admin-model-heading"><strong>Models behind this route</strong><button type="button" class="admin-link-button" aria-label={`Refresh ${route.name} models`} disabled={!connectionReady() || route.inventoryBusy || check().busy} onClick={() => void inspect(route.name)}>Refresh models</button></div>
              <Show when={route.inventoryBusy}><p class="admin-status-text">Loading models…</p></Show><Show when={route.inventoryError}><p role="alert" class="admin-inline-error">{route.inventoryError}</p></Show>
              <ul class="admin-model-list"><For each={legs()}>{(leg) => <li><strong>{leg.declaredModel}</strong><span>{leg.provider}</span></li>}</For></ul>
              <Show when={legs().length > 1}><p class="admin-field-help">AI Gateway may use a backup or another branch. A check tests the path selected for that request.</p></Show>
            </section>
            <label class="admin-form-field"><span>Context window</span><input type="text" inputmode="numeric" aria-label={`${route.name} context window`} value={route.contextWindow} onInput={(event) => updateRoute(route.name, (item) => ({ ...item, contextWindow: Number(event.currentTarget.value) }))} /><small>Maximum conversation size, in tokens.</small></label>
            <Show when={!validContext(route)}><p class="admin-inline-error">Enter a positive whole-number context window before activating this route.</p></Show>
            <TargetCapabilityDiscovery label={route.name} disabled={!connectionReady() || checksBusy() || !gatewayRoutes().includes(route.name)} busy={discoveringTarget() === route.name} onDiscover={() => void discoverRoute(route.name)} />
            <TargetCheckResult busy={check().busy} progressLabel={discoveringTarget() === route.name ? 'Discovering capabilities' : check().administratorConfirmed ? 'Confirming profile' : 'Verifying profile'} ready={verifiedAssignment(route) && validContext(route)} failed={Boolean(check().error || check().routeChanged || check().result && !verifiedAssignment(route) || capabilityResults()[route.name]?.assignable === false)}
              title={check().busy ? discoveringTarget() === route.name ? `Discovering capabilities for ${route.name}…` : check().administratorConfirmed ? `Confirming profile for ${route.name}…` : `Verifying profile for ${route.name}…`
                : verifiedAssignment(route) ? (route.assignment.verification?.method === 'administrator' ? 'Administrator-confirmed' : capabilityResults()[route.name] ? 'Ready for review' : 'Check passed · live-verified')
                  : capabilityResults()[route.name] ? 'Not ready for review' : 'Not verified'}>
              <Show when={check().error}><p>{check().error}</p></Show>
              <Show when={check().routeChanged}><p>The route changed during verification. Check it again before assigning access.</p></Show>
              <Show when={capabilityResults()[route.name]}>{(result) => <DiscoveryCheckEvidence result={result()} />}</Show>
              <Show when={!capabilityResults()[route.name] && (check().result || route.assignment.verification)}><CapabilityEvidence summaries={evidence() ? [evidence()!] : []} profile={profile()} /></Show>
              <Show when={check().result}>{(result) => <Show when={result().verification?.method !== 'administrator'}>
                <Show when={!completeVerification(result())}><p>{reasoningCheckSummary(result())}</p></Show>
                <ReasoningCheckDetails result={result()}><ReasoningCheckOverview result={result()} levels={profile()?.supportedLevels ?? []} /></ReasoningCheckDetails>
              </Show>}</Show>
              <Show when={verifiedAssignment(route) && route.assignment.verification?.method === 'administrator'}><p>Your administrator assessment, not an automated live check.</p></Show>
              <Show when={verifiedAssignment(route) && route.assignment.verification?.method !== 'administrator' && route.assignment.verification?.scope === 'observed-path'}><p class="admin-route-scope-warning">The tested path passed. Other backends remain untested. This route can be assigned with that warning.</p></Show>
              <Show when={!check().busy && !check().result && !capabilityResults()[route.name] && !check().error && !check().routeChanged && !verifiedAssignment(route)}><p>Use Discover above. Results appear here; Advanced is only needed to choose a profile yourself.</p></Show>
            </TargetCheckResult>
            <details class="admin-route-reference"><summary>Advanced: choose a profile</summary>
            <p class="admin-field-help">Optional alternative to Discover. Select a profile or use Discover Profile to find one, then Verify Profile before saving.</p>
            <div class="admin-route-controls">
              <label class="admin-form-field"><span>Pi compatibility profile</span><select aria-label={`${route.name} Pi compatibility profile`} value={refKey(route.assignment.activeProfile)} disabled={catalogBusy() || check().busy || profileEditorBusy()} onChange={(event) => { setProfileEditorRoute(undefined); setRouteProfile(route.name, event.currentTarget.value); }}>
                <option value="" selected={!route.assignment.activeProfile}>Choose a profile</option><For each={dynamicRouteProfiles()}>{(option) => <option value={refKey(option)} selected={refKey(option) === refKey(route.assignment.activeProfile)}>{profileDisplayName(option)}</option>}</For>
              </select><small>Mapping translates request settings; it does not identify the model behind a route.</small></label>
              <Show when={unavailableRouteProfiles()[route.name]}>{(label) => <p role="alert" class="admin-inline-error">{label()} is unavailable for Dynamic Routes. Choose a Dynamic Route profile.</p>}</Show>
            </div>
            <Show when={profile()}>{(selected) => <div class="admin-profile-explanation">
              <strong>{profileDisplayName(selected())}</strong><Show when={profileValidationBasis(selected())}>{(basis) => <p>{basis()}</p>}</Show>
              <dl><div><dt>Reasoning options</dt><dd>{selected().supportedLevels.length ? selected().supportedLevels.map(levelLabel).join(', ') : 'Provider default'}</dd></div><Show when={selected().supportedLevels.length > 0}><div><dt>Reasoning off</dt><dd>{selected().supportedLevels.includes('off') ? 'Supported' : 'Not supported'}</dd></div></Show></dl>
            </div>}</Show>
            <div class="admin-route-action-row" role="group" aria-label={`${route.name} profile actions`}>
            <div class="admin-route-actions"><button type="button" class="admin-secondary-button" aria-label={`Discover Profile for ${route.name}`} disabled={!connectionReady() || check().busy || Boolean(profileEditorRoute()) || !gatewayRoutes().includes(route.name)} onClick={() => setProfileEditorRoute(route.name)}>Discover Profile</button>
              <button type="button" class="admin-secondary-button" aria-label={`Verify Profile for ${route.name}`} disabled={!connectionReady() || !profile() || check().busy || route.inventoryBusy || profileEditorBusy() || !gatewayRoutes().includes(route.name)} onClick={() => { setProfileEditorRoute(undefined); void verifySelectedProfile(route.name); }}>{check().busy && !check().administratorConfirmed ? 'Verifying…' : 'Verify Profile'}</button>
              <Show when={profile()}> <button type="button" class="admin-primary-button" aria-label={`Mark ${route.name} as verified`} disabled={!connectionReady() || !profile() || check().busy || route.inventoryBusy || profileEditorBusy() || !gatewayRoutes().includes(route.name)} onClick={() => { setProfileEditorRoute(undefined); void verifySelectedProfile(route.name, true); }}>Mark as verified</button></Show>
            </div>
            </div>

            <p class="admin-field-help">Verify runs a live check and may use provider credits. Its result appears above.</p>
            <Show when={profile()}><p class="admin-field-help">Mark as verified records your own assessment without a live check; it is not automated evidence.</p></Show>
            <Show when={profileEditorRoute() === route.name}><ReasoningProfileEditor route={route.name} context={managementContext(route.name)} onBusyChange={setProfileEditorBusy} existingRevisions={customRevisions()} onCancel={() => setProfileEditorRoute(undefined)} onSelectProfile={(ref) => { setProfileEditorRoute(undefined); setRouteProfile(route.name, refKey(ref)); }} onSave={(revision) => { setProfileEditorRoute(undefined); setCustomRevisions((items) => [...items, revision]); setRouteProfile(route.name, refKey(profileRef(revision))); setPendingProfileName(String(revision.name ?? 'New profile')); }} /></Show>
            </details>
            <Show when={!gatewayRoutes().includes(route.name)}><button type="button" class="admin-link-button admin-danger-link" aria-label={`Remove ${route.name} stale route`} onClick={() => setPendingRemoval(route.name)}>Remove stale route</button></Show>
            <Show when={pendingRemoval() === route.name}><div class="admin-confirmation" role="alert"><strong>Remove this stale route?</strong><p>It will also be removed from draft access policies.</p><button type="button" class="admin-secondary-button" onClick={() => setPendingRemoval(undefined)}>Keep route</button><button type="button" class="admin-primary-button" aria-label={`Confirm remove ${route.name}`} onClick={() => confirmRemove(route.name)}>Confirm removal</button></div></Show>
          </div>
        </article>;
      }}</For></div>
      <details class="admin-route-reference"><summary>Known compatibility limitations</summary><For each={catalog().notices}>{(notice) => <div><strong>{notice.name}</strong><p>{notice.summary}</p><For each={notice.limitations ?? []}>{(note) => <p>{note}</p>}</For></div>}</For></details>
    </section>

    <section hidden={section() !== 'native'} class="admin-routing-pane" aria-labelledby="native-heading">
      <div class="admin-subsection-heading"><div><h3 id="native-heading">Native routes</h3><p>Select a Bedrock model and Discover its configuration automatically. Saved transports remain unchanged. Other native protocols retain their existing advanced workflow until explicitly extended.</p></div><span class="admin-status">{nativeTargets().length} targets</span></div>
      <div class="admin-route-overview"><Index each={nativeTargets()}>{(target, index) => {
        const clearProof = (update: Partial<NativeDraft>) => {
          if (target().id) setNativeChecks((checks) => ({ ...checks, [target().id!]: null }));
          setNativeTargets((items) => items.map((item, at) => at === index ? { ...item, ...update, enabled: false, verification: undefined, discoveryResult: undefined, checkResult: undefined, error: undefined } : item));
        };
        const selectedProfile = () => findProfile(target().profileRef);
        const failedCheck = () => { const result = target().checkResult; return result?.assignable === false ? result : undefined; };
        const evidence = () => target().verification?.discovery ?? failedCheck()?.capabilitySummary;
        const title = () => `Native Route - ${providerLabel(target().provider)} - ${target().model || 'Add model'}`;
        return <article class="admin-route-entry" aria-label={`${target().label || 'New'} native target`} hidden={catalog().providerCatalogStatus !== undefined && !configuredProviders().some((provider) => provider.provider === target().provider)}>
          <div class="admin-native-target-heading">
            <button type="button" class="admin-route-toggle" aria-label={`Configure ${title()}`} aria-expanded={expandedNative() === index} aria-controls={`native-panel-${index}`} onClick={() => setExpandedNative(expandedNative() === index ? undefined : index)}>
              <span><strong>{title()}</strong><small>{target().label || 'New target'}</small></span>
              <span class="admin-check-pill" data-state={nativeReady(target()) ? 'passed' : 'unclear'}>{nativeReady(target()) ? target().verification?.method === 'administrator' ? 'Administrator-confirmed' : 'Live-verified' : target().busy ? 'Checking…' : 'Not ready'}</span><span class="admin-route-chevron" aria-hidden="true">›</span>
            </button>
            <button type="button" class="admin-link-button admin-danger-link" aria-label={`Remove ${target().label || title()}`} disabled={target().busy} onClick={() => {
              if (target().id) setNativeChecks((checks) => Object.fromEntries(Object.entries(checks).filter(([id]) => id !== target().id)));
              setNativeTargets((items) => items.filter((_, at) => at !== index)); setExpandedNative(undefined); setNativeProfileEditor(undefined);
            }}>Remove</button>
          </div>
          <div hidden={expandedNative() !== index} id={`native-panel-${index}`} class="admin-route-panel">
              <div class="admin-route-controls">
                <label class="admin-form-field"><span>Provider</span><select aria-label={`Native target ${index + 1} provider`} value={target().provider} disabled={target().busy} onChange={(event) => {
                  const provider = event.currentTarget.value;
                  if (provider === target().provider) return;
                  const next = newNativeIdentity(provider); const profile = nativePreparedProfileRef(next);
                  if (profile) clearProof({ ...next, profileRef: profile, rememberedRegion: undefined });
                }}><For each={selectableProviders()}>{(provider) => <option value={provider.provider}>{provider.label}</option>}</For></select><small>Only uniquely selectable provider bindings are available.</small></label>
                <Show when={target().transport && target().transport !== 'aig-legacy-compat'}><label class="admin-form-field"><span>AWS region</span><input aria-label={`Native target ${index + 1} region`} value={target().region ?? ''} disabled={target().busy} onInput={(event) => clearProof({ region: event.currentTarget.value })} /><small>Region used in the Bedrock Runtime path.</small></label></Show>
                <label class="admin-form-field"><span>Label</span><input aria-label={`Native target ${index + 1} label`} value={target().label} disabled={target().busy} onInput={(event) => setNativeTargets((items) => items.map((item, at) => at === index ? { ...item, label: event.currentTarget.value } : item))} /></label>
                <label class="admin-form-field"><span>Exact model identifier</span><input aria-label={`Native target ${index + 1} model`} list={`native-model-suggestions-${index}`} value={target().model} disabled={target().busy} onInput={(event) => {
                  const model = event.currentTarget.value;
                  if (model === target().model) return;
                  const rememberedRegion = target().region ?? target().rememberedRegion;
                  // Editing the model never silently upgrades a saved Invoke or
                  // compat target. The operator owns its explicit operation.
                  const next = target().id ? { provider: target().provider, model, transport: target().transport, region: target().region }
                    : newNativeIdentity(target().provider, model, rememberedRegion);
                  const profileRef = nativePreparedProfileRef(next); clearProof({ ...next, rememberedRegion, ...(profileRef && { profileRef }) });
                }} /><datalist id={`native-model-suggestions-${index}`}><For each={nativeModelSuggestions(target().provider)}>{(model) => <option value={model} />}</For></datalist><small>Route-derived names for this provider are suggestions only.</small></label>
                <label class="admin-form-field"><span>Context window</span><input type="text" inputmode="numeric" aria-label={`Native target ${index + 1} context window`} value={target().contextWindow} disabled={target().busy} onInput={(event) => setNativeTargets((items) => items.map((item, at) => at === index ? { ...item, contextWindow: Number(event.currentTarget.value) } : item))} /><small>Must be greater than 16,384 tokens.</small></label>

              </div>
              <Show when={!Number.isSafeInteger(target().contextWindow) || target().contextWindow <= 16384}><p class="admin-inline-error">Enter a whole-number context window greater than 16,384.</p></Show>
              <Show when={target().provider === 'aws-bedrock'}><TargetCapabilityDiscovery label={`native target ${index + 1}`} disabled={!connectionReady() || checksBusy() || !target().model || !target().label || target().contextWindow <= 16384} busy={Boolean(target().verificationRequest && target().busy && discoveringTarget()?.startsWith('native-'))} onDiscover={() => void discoverNative(index)} /></Show>
              <TargetCheckResult ready={nativeReady(target())} busy={target().busy} failed={Boolean(target().error || target().checkResult?.assignable === false || target().discoveryResult?.assignable === false)}
                title={target().busy ? 'Checking…' : nativeReady(target()) ? (target().verification?.method === 'administrator' ? 'Administrator-confirmed' : target().discoveryResult ? 'Ready for review' : 'Check passed · live-verified') : target().checkResult || target().discoveryResult ? 'Not ready for review' : 'Not verified'}>
                <Show when={target().error}><p>{target().error}</p></Show>
                <Show when={target().discoveryResult}>{(result) => <DiscoveryCheckEvidence result={result()} />}</Show>
                <Show when={!target().discoveryResult && (target().checkResult || target().verification)}><CapabilityEvidence summaries={evidence() ? [evidence()!] : []} profile={selectedProfile()} /></Show>
                <Show when={failedCheck()}>{(result) => <>
                  <p>{reasoningCheckSummary(result(), result().cacheEvidence?.explanation ?? 'The check did not establish compatibility. This target remains inactive.')}</p>
                  <Show when={result().diagnostics?.length}><ReasoningCheckDetails result={result()} /></Show>
                </>}</Show>
                <Show when={nativeReady(target())}><p>{target().verification?.method === 'administrator' ? 'Your administrator assessment, not an automated live check.' : 'Automated verification of this exact target and selected profile.'}</p></Show>
                <Show when={!target().busy && !target().error && !target().discoveryResult && !target().checkResult && !nativeReady(target())}><p>{target().provider === 'aws-bedrock' ? 'Use Discover above. Results appear here.' : 'Choose a profile in Advanced below, then verify it. Results appear here.'}</p></Show>
              </TargetCheckResult>
              <details class="admin-route-reference" open={target().provider !== 'aws-bedrock'}><summary>Advanced: choose a profile</summary>
              <p class="admin-field-help">Choose a profile yourself instead of using automatic Discover. Verify Profile runs a live check; Mark as verified records your assessment without a live check. Results appear above.</p>
              <label class="admin-form-field"><span>Pi compatibility profile</span><select aria-label={`Native target ${index + 1} profile`} value={refKey(target().profileRef)} disabled={target().busy} onChange={(event) => {
                  const profile = assignableProfiles().find((candidate) => refKey(candidate) === event.currentTarget.value);
                  if (profile) clearProof({ profileRef: profileRefFromEntry(profile) });
                }}><For each={profilesForTarget(target())}>{(profile) => <option value={refKey(profile)} selected={refKey(profile) === refKey(target().profileRef)}>{profileDisplayName(profile)}</option>}</For></select><small>{selectedProfile()?.supportedLevels.length ? `Pi levels: ${selectedProfile()!.supportedLevels.map(levelLabel).join(', ')}.` : 'All seven Pi preferences normalize to Provider default; no exact effort or Off state is claimed.'}</small></label>
              <div class="admin-route-actions"><button type="button" class="admin-secondary-button" aria-label={`Discover Profile for native target ${index + 1}`} disabled={!connectionReady() || target().busy || !target().model || nativeProfileEditor() !== undefined} onClick={() => setNativeProfileEditor(index)}>Discover Profile</button><Show when={!target().transport || target().transport === 'aig-legacy-compat' || target().profileRef.id === BEDROCK_MESSAGES_DEFAULT_PROFILE || isGeneratedNativeProfileId(target().profileRef.id)}><button type="button" class="admin-secondary-button" disabled={!connectionReady() || target().busy || !target().label || !target().model || !selectedProfile() || target().contextWindow <= 16384} onClick={() => void verifyNativeTarget(index)}>{target().busy ? 'Verifying…' : 'Verify Profile'}</button></Show><Show when={selectedProfile()}><button type="button" class="admin-primary-button" disabled={!connectionReady() || target().busy || !target().label || !target().model || !selectedProfile() || target().contextWindow <= 16384} onClick={() => void verifyNativeTarget(index, true)}>Mark as verified</button></Show></div>
              <Show when={target().profileRef.id === BEDROCK_MESSAGES_DEFAULT_PROFILE}><p class="admin-field-help">Verify authorizes up to four billable requests on this exact model, at most 2,048 output tokens each and 90 seconds each. The two cache requests include a public prefix of approximately 60 KiB; cost depends on the configured provider. No retries or model substitutions. Tools and exact replay are required. Input-prefix caching and incremental streaming are reported separately; Gateway HIT is whole-response reuse only. Reasoning remains provider-controlled.</p></Show>
              <Show when={nativeProfileEditor() === index}><ReasoningProfileEditor route={`${target().provider}/${target().model}`} discoverCompatibility={() => discoverNativeCompatibility({ target: nativeSubmission()[index], ...(gatewayDraft() && { gateway: gatewayDraft()! }), maxCompletionTokens: DISCOVERY_COMPLETION_TOKENS })} onBusyChange={setProfileEditorBusy} existingRevisions={customRevisions()} onCancel={() => setNativeProfileEditor(undefined)} onSelectProfile={(ref) => { setNativeProfileEditor(undefined); clearProof({ profileRef: ref }); }} onSave={(revision) => { const ref = profileRef(revision); if (!ref) return; setNativeProfileEditor(undefined); setCustomRevisions((items) => [...items, revision]); clearProof({ profileRef: ref }); setPendingProfileName(String(revision.name ?? 'New profile')); }} /></Show>
              </details>
            </div></article>;
          }}</Index></div>
      <Show when={!selectableProviders().length}><p class="admin-status-text">{catalog().providerCatalogStatus === 'ready'
        ? 'No provider configurations are available to add.'
        : 'Provider discovery is unavailable. Check the connection to add a Native Route.'}</p></Show>
      <Show when={selectableProviders().length}><div class="admin-route-actions"><button type="button" class="admin-secondary-button" onClick={() => {
        const provider = selectableProviders()[0]; const identity = provider && newNativeIdentity(provider.provider);
        const profile = identity && nativePreparedProfileRef(identity);
        if (identity && profile) { const index = nativeTargets().length; setNativeTargets((items) => [...items, { ...identity, label: '', contextWindow: 200000, profileRef: profile, enabled: false }]); setExpandedNative(index); }
      }}>Add Native Route</button></div></Show>
    </section>

    <section hidden={section() !== 'access'} class="admin-routing-pane" aria-labelledby="groups-heading">
      <div class="admin-subsection-heading"><div><h3 id="groups-heading">Group access</h3><p>Choose which available routes each Access group can use. The first matching configured policy wins.</p></div></div>
      <Show when={unconfiguredGroups().length}><div class="admin-add-row"><label class="admin-form-field"><span>Access group</span><select aria-label="Unconfigured access group" value={groupToAdd()} onChange={(event) => setGroupToAdd(event.currentTarget.value)}><For each={unconfiguredGroups()}>{(group) => <option value={group} selected={group === groupToAdd()}>{group}</option>}</For></select></label><button type="button" class="admin-secondary-button" onClick={addGroupPolicy}>Add group policy</button></div></Show>
      <Show when={!availableAccessGroups.length}><p class="admin-status-text">Configure an Access group in Environment → Access before assigning a route.</p></Show>
      <For each={groups()}>{(group) => <section class="admin-access-policy">
        <div class="admin-policy-heading"><button type="button" class="admin-policy-toggle" aria-label={`${group.accessGroup} policy`} aria-expanded={expandedGroup() === group.accessGroup} onClick={() => setExpandedGroup(expandedGroup() === group.accessGroup ? undefined : group.accessGroup)}><strong>{group.accessGroup}</strong><span>{normalizedPolicy(group).routes.length} available routes</span></button><button type="button" class="admin-link-button admin-danger-link" aria-label={`Remove ${group.accessGroup} policy`} onClick={() => setGroups((items) => items.filter((item) => item.accessGroup !== group.accessGroup))}>Remove policy</button></div>
        <div hidden={expandedGroup() !== group.accessGroup}>
          <Show when={group.routes.some((name) => !eligibleNames().includes(name))}><p class="admin-route-scope-warning">Unconfirmed or unavailable routes are inactive and will not be included when you Save.</p></Show>
          <PolicyFields label={group.accessGroup} options={eligiblePolicyOptions()} policy={normalizedPolicy(group)} levels={supportedLevels(normalizedPolicy(group).defaultRoute)} onToggle={(name) => setGroups((items) => items.map((item) => item.accessGroup === group.accessGroup ? togglePolicyRoute(item, name) : item))} onDefault={(name) => setGroups((items) => items.map((item) => item.accessGroup === group.accessGroup ? { ...normalizedPolicy(item), defaultRoute: name, reasoning: preferredLevel(name) } : item))} onReasoning={(level) => setGroups((items) => items.map((item) => item.accessGroup === group.accessGroup ? { ...normalizedPolicy(item), reasoning: level } : item))} />
        </div>
      </section>}</For>
      <Show when={groups().length > 1}><div class="admin-policy-copy"><label class="admin-form-field"><span>Copy from group</span><select aria-label="Policy source" value={applyGroupSource()} onChange={(event) => setApplyGroupSource(event.currentTarget.value)}><For each={groups()}>{(group) => <option value={group.accessGroup}>{group.accessGroup}</option>}</For></select></label><button type="button" class="admin-secondary-button" onClick={() => setApplyGroupsOpen(true)}>Apply to all groups</button></div></Show>
      <Show when={applyGroupsOpen()}><div class="admin-confirmation" role="alert"><strong>Copy one group policy</strong><p>{applyGroupSource()} will be copied to {groups().map((group) => group.accessGroup).join(', ')}.</p><button type="button" class="admin-secondary-button" onClick={() => setApplyGroupsOpen(false)}>Cancel</button><button type="button" class="admin-primary-button" onClick={copyGroupToAll}>Confirm group changes</button></div></Show>
      <section class="admin-fallback-policy" aria-labelledby="fallback-heading"><h3 id="fallback-heading">Users without a group policy</h3><p>Fallback access is for users without a matching configured group, including manually added users. When disabled, those users get no routes.</p>
        <label class="admin-toggle-field"><input type="checkbox" aria-label="Enable fallback access" checked={fallbackEnabled()} onChange={(event) => setFallbackEnabled(event.currentTarget.checked)} /><span>Enable fallback access</span></label>
        <Show when={fallbackEnabled()} fallback={<p class="admin-status-text">No fallback access</p>}><PolicyFields label="Fallback" options={eligiblePolicyOptions()} policy={normalizedFallback()} levels={supportedLevels(normalizedFallback().defaultRoute)} onToggle={(name) => setFallbackPolicy((policy) => togglePolicyRoute(policy, name))} onDefault={(name) => setFallbackPolicy((policy) => ({ ...normalizedPolicy(policy), defaultRoute: name, reasoning: preferredLevel(name) }))} onReasoning={(level) => setFallbackPolicy((policy) => ({ ...normalizedPolicy(policy), reasoning: level }))} /></Show>
      </section>
    </section>
    <Show when={pendingProfileName()}><div class="admin-unsaved-banner" role="status"><strong>{pendingProfileName()} is a draft</strong><span>Verify or confirm it, assign a group, then confirm Save to keep the profile and assignment.</span></div></Show>
    <Show when={!checksBusy() && saveHelp()}><p class="admin-routing-save-help" role="status" data-ready={canSave()}>{saveHelp()}</p></Show>
    <For each={submittedNames()}>{(name) => <input type="hidden" name="dynamicRoutes" value={name} />}</For>
    <For each={routes().filter((route) => route.assignment.activeProfile && validContext(route))}>{(route) => <><input type="hidden" name="routeContextRoute" value={route.name} /><input type="hidden" name="routeContextWindow" value={route.contextWindow} /></>}</For>
    <input type="hidden" name="defaultRoute" value={compatibilityDefault()?.defaultRoute ?? ''} /><input type="hidden" name="reasoning" value={compatibilityDefault()?.reasoning ?? 'off'} />
    <input type="hidden" name="groupRouting" value={JSON.stringify(submittedGroups())} /><input type="hidden" name="fallbackRouting" value={JSON.stringify(submittedFallback())} /><input type="hidden" name="routeChecks" value={JSON.stringify(routeChecks())} />
    <input type="hidden" name="reasoningConfiguration" value={JSON.stringify(serializedConfiguration())} />
    <input type="hidden" name="nativeTargets" value={JSON.stringify(nativeSubmission())} />
    <Show when={nativeDirty()}><input type="hidden" name="nativeChecks" value={JSON.stringify(nativeChecks())} /></Show>
  </div>;
};
export default AiRoutingFields;
/* v8 ignore stop */
