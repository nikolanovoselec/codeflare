import { discoverPiCompatibility, type DiscoveryInput } from '../reasoning-discovery';
import { BEDROCK_MESSAGES_DEFAULT_PROFILE } from '../native-ai-target-draft';
import type { TargetCapabilityResult } from './contract';
import { capabilityEvidenceMatches, MAX_CAPABILITY_SUBMISSIONS, type CapabilitySummaryV2 } from './contract';
import { completedProfileCheck } from '../reasoning-verification';
export type { TargetCapabilityResult } from './contract';
import { canonicalHash, getBuiltInProfile, isCanonicalNativeDiscoveryProfile, normalizeCustomProfile, type PiReasoningLevel, type NormalizedReasoningProfile } from '../reasoning-profiles';

export type TargetCapabilityInput = Omit<DiscoveryInput, 'profile' | 'offCandidateMapping' | 'requireCacheEvidence' | 'endpoint' | 'campaignDeadline'>;

/** These are audited request *forms*, not model capability assertions. Existing
 * profiles supply the finite protocol vocabulary; their model labels/provenance
 * do not participate in selection. A newly named model uses the same probes.
 * Native currently implements only the observed Bedrock Messages boundary;
 * adding Azure would mean a deliberate protocol extension, not URL guessing. */
export function capabilityCandidates(native: boolean): NormalizedReasoningProfile[] {
  if (native) return ['off', 'low', 'medium', 'high', 'xhigh', 'max'].map((level) => nativeProfile(level === 'low' ? ['minimal', 'low'] : [level as PiReasoningLevel]));
  const baseline = getBuiltInProfile('dynamic-bedrock-anthropic-provider-default')!;
  const forms = [undefined, ...[
    'openai-gpt-chat-tools-reasoning', 'workers-ai-gemma-thinking', 'workers-ai-kimi-k-thinking',
    'workers-ai-glm-thinking', 'codeflare-inference-mesh-binary-thinking',
  ].map((id) => getBuiltInProfile(id)!)];
  const seen = new Set<string>();
  return forms.flatMap((form) => {
    // One evidenced normalized enabled mapping is enough; claiming seven
    // graduated effort levels would require seven semantics, not seven labels.
    const level = form?.supportedLevels.includes('medium') ? 'medium' : form?.supportedLevels.find((item) => item !== 'off');
    const semantic = { removePaths: form?.removePaths ?? baseline.removePaths,
      levels: form && level ? { [level]: form.levels[level] } : {}, supportedLevels: level ? [level] : [],
      ...(!level && { reasoningMode: 'provider-default' as const }) };
    const key = canonicalHash(semantic);
    if (seen.has(key)) return [];
    seen.add(key);
    return (['stream', 'buffered'] as const).map((response) => {
      // Cloudflare currently documents /compat as the Dynamic invocation API.
      // Bind this choice into the same immutable contract that runtime uses;
      // historical profiles retain their existing REST-first behavior.
      const compatibility = { response, toolNames: 'repeated-complete' as const, transport: 'compat' as const };
      // Contract-addressed IDs deduplicate across routes/models. Evidence lives
      // in the target receipt, never in a globally "verified" generated profile.
      const id = `discovered-${canonicalHash({ semantic, compatibility }).slice(0, 24)}`;
      return normalizeCustomProfile({ id, name: `Discovered OpenAI ${response} · ${level ? 'normalized reasoning' : 'Provider default'}`,
        family: 'Discovered protocol', schemaVersion: 1, revision: 1, enabled: true,
        ...semantic, aliases: {}, offSemantics: { status: 'unsupported' }, compatibility,
        limitations: ['Only the exercised backend is certified; other Dynamic branches may differ.',
          level ? 'All Pi preferences normalize to the tested mapping; no graduated fidelity or Off claim.'
            : 'All seven Pi preferences normalize to Provider default; no claim that reasoning is Off or visibly enabled.',
          ...(response === 'buffered' ? ['Provider JSON is delivered as one completed SSE chunk; this is not incremental generation.'] : [])] });
    });
  });
}

function nativeProfile(supported: PiReasoningLevel[]): NormalizedReasoningProfile {
  const audited = getBuiltInProfile('bedrock-anthropic-native-opus-auto')!;
  const supportedLevels = audited.supportedLevels.filter((level) => supported.includes(level));
  const semantic = { supportedLevels, removePaths: audited.removePaths,
    levels: Object.fromEntries(supportedLevels.map((level) => [level, audited.levels[level]])),
    aliases: supportedLevels.includes('minimal') ? { minimal: 'low' } : {},
    offSemantics: supportedLevels.includes('off') ? audited.offSemantics : { status: 'unsupported' } };
  return normalizeCustomProfile({ schemaVersion: 1, revision: 1, enabled: true,
    id: `bedrock-anthropic-native-discovered-${canonicalHash(semantic).slice(0, 24)}`,
    name: 'Discovered Bedrock Anthropic controls', family: 'Discovered native protocol', ...semantic,
    limitations: ['Only completed target-bound mappings are selectable; accepted efforts do not prove graduated fidelity.',
      ...(supportedLevels.includes('minimal') ? ['Minimal explicitly aliases Low.'] : []),
      'Cache and incremental delivery are measured separately for each mapping.'] });
}

/** One submission counter/deadline for the whole explicit action, never per form. */
function campaign(input: TargetCapabilityInput) {
  let count = 0;
  const totals: Record<string, number> = { logicalProbes: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const deadline = Date.now() + 10 * 60_000;
  const fetcher = input.fetcher ?? input.fetchImpl ?? fetch;
  const exhausted = () => count >= MAX_CAPABILITY_SUBMISSIONS || Date.now() >= deadline;
  const boundedFetch: typeof fetch = async (url, init) => {
    if (exhausted()) throw new Error('capability_campaign_limit');
    count++;
    return fetcher(url, init);
  };
  return { count: () => count, exhausted, accounting: () => ({ ...totals, httpAttempts: count }),
    run: async (profile: NormalizedReasoningProfile) => {
      const report = await discoverPiCompatibility({ ...input, profile, fetcher: boundedFetch,
        campaignDeadline: deadline, maxCompletionTokens: Math.min(input.maxCompletionTokens, 2048),
        timeoutMs: Math.min(input.timeoutMs ?? 90_000, 90_000), requireCacheEvidence: true });
      for (const key of Object.keys(totals)) totals[key] += report.accounting[key];
      return report;
    } };
}

function nativeBackendConsistent(reports: Record<string, any>[]): boolean {
  const observations = reports.flatMap((report) => [...report.distinctMappings.flatMap((item: Record<string, any>) =>
    [item.reasoningProbe, item.toolLifecycle.first, item.toolLifecycle.replay]).filter(Boolean), ...(report.cacheEvidence?.observations ?? [])]);
  return ['provider', 'model'].every((key) => new Set(observations.map((item) => item.backend?.[key]).filter(Boolean)).size <= 1);
}

function aggregateNative(profile: NormalizedReasoningProfile, reports: Record<string, any>[], input: TargetCapabilityInput, count: number): Record<string, any> {
  const first = reports[0];
  const distinctMappings = reports.flatMap((report) => report.distinctMappings);
  const capabilities: CapabilitySummaryV2 = { schemaVersion: 2, mappings: reports.flatMap((report) => report.capabilitySummary?.mappings ?? []) };
  const diagnostics = reports.flatMap((report) => report.diagnostics ?? []);
  const consistent = nativeBackendConsistent(reports);
  if (!consistent) diagnostics.push({ levels: [], stage: 'branch-correlation', code: 'backend_changed' });
  const stopDiscovery = !consistent || reports.some((report) => report.stopDiscovery);
  const verifiedLevels = reports.flatMap((report) => report.piCompatibility.verifiedLevels);
  const failedLevels = profile.supportedLevels.filter((level) => !verifiedLevels.includes(level));
  const assignable = reports.length > 0 && !stopDiscovery && reports.every((report) => report.assignable
    && completedProfileCheck(report, { supportedLevels: report.normalizedDraft.supportedLevels }))
    && capabilityEvidenceMatches(capabilities, profile, input.native?.transport);
  const report: Record<string, any> = { ...first, profileId: profile.id, distinctMappings, diagnostics, stopDiscovery, assignable,
    classification: assignable ? 'Verified' : 'Inconclusive', capabilitySummary: capabilities,
    compatibleLevels: reports.flatMap((report) => report.compatibleLevels),
    piCompatibility: { status: assignable ? 'verified' : 'partial', verifiedLevels, failedLevels },
    reasoningConfiguration: { ...first?.reasoningConfiguration,
      off: profile.supportedLevels.includes('off') ? reports.find((report) => report.distinctMappings.some((item: Record<string, any>) => item.levels.includes('off')))?.reasoningConfiguration.off : 'unsupported-by-profile',
      routeHealthVerified: reports.length > 0 && reports.every((report) => report.reasoningConfiguration.routeHealthVerified) },
    accounting: { ...Object.fromEntries(['logicalProbes', 'promptTokens', 'completionTokens', 'totalTokens'].map((key) =>
      [key, reports.reduce((sum, report) => sum + report.accounting[key], 0)])), httpAttempts: count },
    evidence: { ...first?.evidence, toolReplay: assignable, status: assignable ? 'Verified' : 'Inconclusive' },
    normalizedDraft: { ...first?.normalizedDraft, profileId: profile.id, supportedLevels: [...profile.supportedLevels],
      classification: assignable ? 'Verified' : 'Inconclusive', evidence: { ...first?.normalizedDraft?.evidence, toolReplay: assignable, status: assignable ? 'Verified' : 'Inconclusive' } } };
  // No single-form cache projection can speak for an assembled multiform profile.
  if (reports.length > 1) delete report.cacheEvidence;
  if (!completedProfileCheck(report, profile)) { report.assignable = false; report.classification = 'Inconclusive'; }
  return report;
}

/** Recheck only the selected immutable native contract, never expand its forms. */
export async function verifyNativeCapabilityProfile(input: TargetCapabilityInput, profile: NormalizedReasoningProfile): Promise<Record<string, any>> {
  if (!input.native || !profile.enabled || (profile.id !== BEDROCK_MESSAGES_DEFAULT_PROFILE && !isCanonicalNativeDiscoveryProfile(profile))) {
    throw new TypeError('Selected native capability profile is not an audited contract');
  }
  const canonical = profile.id === BEDROCK_MESSAGES_DEFAULT_PROFILE ? getBuiltInProfile(profile.id)! : normalizeCustomProfile(profile);
  if (canonicalHash(canonical) !== canonicalHash(profile)) throw new TypeError('Selected native capability profile hash mismatch');
  const bounded = campaign(input);
  const reports: Record<string, any>[] = [];
  const groups = new Map<string, PiReasoningLevel[]>();
  for (const level of profile.supportedLevels) {
    const key = canonicalHash(profile.levels[level]);
    groups.set(key, [...(groups.get(key) ?? []), level]);
  }
  const selected = profile.reasoningMode === 'provider-default' ? [profile] : [...groups.values()].map((levels) => ({ ...profile,
    supportedLevels: levels, levels: Object.fromEntries(levels.map((level) => [level, profile.levels[level]])),
    aliases: Object.fromEntries(Object.entries(profile.aliases).filter(([level]) => levels.includes(level as PiReasoningLevel))) }));
  for (const form of selected) {
    const report = await bounded.run(form);
    reports.push(report);
    if (report.stopDiscovery || bounded.exhausted() || !nativeBackendConsistent(reports)) break;
  }
  const report = aggregateNative(profile, reports, input, bounded.count());
  report.accounting = bounded.accounting();
  return report;
}

/** Explicit administrator action. Failed forms are diagnostics, not executable levels. */
export async function discoverTargetCapabilities(input: TargetCapabilityInput): Promise<TargetCapabilityResult> {
  if (!input.native && !input.route.startsWith('dynamic/') && !input.route.startsWith('aws-bedrock/')) {
    throw new TypeError('Native discovery supports the observed Bedrock contract only; this protocol is not supported');
  }
  const bounded = campaign(input);
  const attempts: TargetCapabilityResult['attempts'] = [];
  const retained: Array<{ profile: NormalizedReasoningProfile; report: Record<string, any> }> = [];
  let stopped = false;
  const candidates = capabilityCandidates(Boolean(input.native));
  if (input.native) candidates.push(getBuiltInProfile(BEDROCK_MESSAGES_DEFAULT_PROFILE)!);
  for (const profile of candidates) {
    if (input.native && profile.reasoningMode === 'provider-default' && retained.length) break;
    const before = bounded.count();
    const report = await bounded.run(profile);
    attempts.push({ contract: profile.id, classification: report.classification, capabilities: report.capabilitySummary,
      diagnostics: report.diagnostics ?? [], httpAttempts: bounded.count() - before });
    if (input.native && !nativeBackendConsistent([...retained.map((item) => item.report), report])) {
      if (!report.diagnostics.some((item: { code: string }) => item.code === 'backend_changed')) {
        attempts.at(-1)!.diagnostics.push({ levels: [], stage: 'branch-correlation', code: 'backend_changed' });
      }
      attempts.at(-1)!.classification = 'Inconclusive';
      stopped = true;
      break;
    }
    if (report.stopDiscovery || bounded.exhausted()) { stopped = true; break; }
    if (report.assignable && completedProfileCheck(report, profile) && capabilityEvidenceMatches(report.capabilitySummary, profile, input.native?.transport)) {
      retained.push({ profile, report });
      if (!input.native) break; // Never chase cache via buffered after a working wire lifecycle.
    }
  }
  if (!stopped && retained.length) {
    const profile = input.native && retained[0].profile.reasoningMode !== 'provider-default'
      ? nativeProfile(retained.flatMap((item) => item.profile.supportedLevels)) : retained[0].profile;
    const report = input.native ? aggregateNative(profile, retained.map((item) => item.report), input, bounded.count()) : retained[0].report;
    report.accounting = bounded.accounting();
    if (report.assignable && completedProfileCheck(report, profile)) return { schemaVersion: 1, assignable: true, classification: 'Verified',
      explanation: report.cacheEvidence?.observations[0]?.effectiveFinishReason === 'content_filter'
        ? `Working tools and exact replay were verified. ${report.cacheEvidence.explanation}`
        : 'Working tools and exact replay were verified. Review and Save to enable this target; reasoning, streaming and input caching are independent observations.',
      capabilities: report.capabilitySummary, profile, report, attempts, accounting: { httpAttempts: bounded.count() } };
  }
  return { schemaVersion: 1, assignable: false, classification: 'Inconclusive',
    explanation: stopped ? 'Discovery stopped at an authentication, provider, framing, timeout or campaign boundary. Inspect the stage diagnostics; no fresh activation proof was issued.'
      : 'No tested contract completed the required tool lifecycle and exact mapping evidence. Optional cache absence alone does not prevent activation.',
    attempts, accounting: { httpAttempts: bounded.count() } };
}
