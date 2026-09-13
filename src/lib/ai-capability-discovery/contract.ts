import { canonicalJson, isCanonicalNativeDiscoveryProfile, isGeneratedNativeProfileId, isPiReasoningLevel,
  type NormalizedReasoningProfile, type PiReasoningLevel, type ScalarWrite } from '../reasoning-profiles';
export { isGeneratedNativeProfileId, isGeneratedDiscoveryProfileId } from '../reasoning-profiles';
// Covers the entire finite current contract search (38 worst-case submissions),
// without making the limit grow when a model or saved profile is added.
export const MAX_CAPABILITY_SUBMISSIONS = 40;

export interface TargetCapabilityResult {
  schemaVersion: 1;
  assignable: boolean;
  classification: 'Verified' | 'Inconclusive' | 'Unsupported';
  explanation: string;
  capabilities?: CapabilitySummary;
  profile?: NormalizedReasoningProfile;
  report?: Record<string, any>;
  attempts: Array<{ contract: string; classification: string; capabilities?: CapabilitySummary; diagnostics: unknown[]; httpAttempts: number }>;
  accounting: { httpAttempts: number };
}

/** Sanitized observations for one exact semantic mapping, including aliases.
 * Empty levels describe Provider default, never a literal Off mapping. */
export interface CapabilityMapping {
  levels: PiReasoningLevel[];
  transport: 'rest' | 'compat' | 'bedrock-invoke' | 'bedrock-eventstream';
  tools: boolean;
  replay: boolean;
  reasoning: 'provider-default' | 'verified-disabled' | 'observed-enabled' | 'accepted-unverified' | 'not-tested';
  streaming: 'incremental' | 'not-observed' | 'not-tested';
  cache: 'provider-prefix' | 'gateway-response' | 'inconclusive' | 'not-tested';
}

export interface CapabilitySummaryV2 {
  schemaVersion: 2;
  mappings: CapabilityMapping[];
}

/** Read-only historical contract. Never reinterpret its grades as v2 evidence. */
export interface LegacyCapabilitySummary {
  schemaVersion: 1;
  tools: boolean;
  replay: boolean;
  cache: 'provider-prefix' | 'gateway-response' | 'inconclusive' | 'not-tested';
  nativePromptCache: boolean;
  reasoning: 'provider-default' | 'observed-enabled' | 'unverified';
  streaming: 'incremental' | 'not-observed';
  grade: 'Minimum' | 'Acceptable' | 'Optimal' | 'Not qualified';
}

export type CapabilitySummary = CapabilitySummaryV2 | LegacyCapabilitySummary;

export function legacyCapabilityQualifies(evidence: LegacyCapabilitySummary): boolean {
  return Boolean(evidence?.tools && evidence.replay && ['provider-prefix', 'gateway-response'].includes(evidence.cache)
    && (!evidence.nativePromptCache || evidence.cache === 'provider-prefix')
    && evidence.grade === (evidence.reasoning === 'unverified' ? 'Minimum' : evidence.streaming === 'incremental' ? 'Optimal' : 'Acceptable'));
}

export function parseCapabilitySummary(value: unknown): CapabilitySummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid capabilities');
  const item = value as Record<string, unknown>;
  if (item.schemaVersion === 2) {
    if (Object.keys(item).length !== 2 || Object.keys(item).some((key) => !['schemaVersion', 'mappings'].includes(key))
      || !Array.isArray(item.mappings) || item.mappings.length > 7) throw new Error('Invalid capabilities');
    const seen = new Set<PiReasoningLevel>();
    const mappings = Array.from(item.mappings, (raw): CapabilityMapping => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid capability mapping');
      const row = raw as Record<string, unknown>;
      const fields = ['levels', 'transport', 'tools', 'replay', 'reasoning', 'streaming', 'cache'];
      if (Object.keys(row).length !== fields.length || Object.keys(row).some((key) => !fields.includes(key))
        || !Array.isArray(row.levels) || row.levels.length > 7 || !Array.from(row.levels).every(isPiReasoningLevel)
        || typeof row.tools !== 'boolean' || typeof row.replay !== 'boolean'
        || typeof row.transport !== 'string' || !['rest', 'compat', 'bedrock-invoke', 'bedrock-eventstream'].includes(row.transport)
        || typeof row.reasoning !== 'string' || !['provider-default', 'verified-disabled', 'observed-enabled', 'accepted-unverified', 'not-tested'].includes(row.reasoning)
        || typeof row.streaming !== 'string' || !['incremental', 'not-observed', 'not-tested'].includes(row.streaming)
        || typeof row.cache !== 'string' || !['provider-prefix', 'gateway-response', 'inconclusive', 'not-tested'].includes(row.cache)) throw new Error('Invalid capability mapping');
      if ((row.levels.length === 0) !== (row.reasoning === 'provider-default')
        || row.levels.length === 0 && (item.mappings as unknown[]).length !== 1) throw new Error('Invalid capability mapping');
      const levels = row.levels as PiReasoningLevel[];
      for (const level of levels) {
        if (seen.has(level)) throw new Error('Duplicate capability level');
        seen.add(level);
      }
      return { ...row, levels: [...levels] } as CapabilityMapping;
    });
    return { schemaVersion: 2, mappings };
  }
  // Preserve the strict legacy decoder and its original qualification policy.
  const fields = ['schemaVersion', 'tools', 'replay', 'cache', 'nativePromptCache', 'reasoning', 'streaming', 'grade'];
  if (Object.keys(item).length !== fields.length || Object.keys(item).some((key) => !fields.includes(key))
    || item.schemaVersion !== 1 || !['tools', 'replay', 'nativePromptCache'].every((key) => typeof item[key] === 'boolean')
    || !['provider-prefix', 'gateway-response', 'inconclusive', 'not-tested'].includes(String(item.cache))
    || !['provider-default', 'observed-enabled', 'unverified'].includes(String(item.reasoning))
    || !['incremental', 'not-observed'].includes(String(item.streaming))
    || !['Minimum', 'Acceptable', 'Optimal', 'Not qualified'].includes(String(item.grade))) throw new Error('Invalid capabilities');
  return { ...item } as unknown as LegacyCapabilitySummary;
}

function literalOff(profile: NormalizedReasoningProfile): boolean {
  const { status, path, value } = profile.offSemantics;
  if (status !== 'explicit-toggle' && status !== 'explicit-value') return false;
  // An arbitrary scalar labelled "off" is not an audited disable control.
  const disabled = path === 'thinking.type' && value === 'disabled'
    || path === 'reasoning_effort' && value === 'none'
    || path === 'chat_template_kwargs.enable_thinking' && value === false;
  return disabled && profile.aliases.off === undefined
    && Boolean(profile.levels.off?.some((write) => write.path === path && Object.is(write.value, value)));
}

function mappingTransport(profile: NormalizedReasoningProfile, writes: ScalarWrite[], transport?: string): CapabilityMapping['transport'] | undefined {
  if (profile.id.startsWith('bedrock-anthropic-native-')) {
    if (transport === 'aig-bedrock-anthropic-invoke') return 'bedrock-invoke';
    if (transport === 'aig-bedrock-anthropic-eventstream') return 'bedrock-eventstream';
    if (transport !== 'aig-bedrock-anthropic-auto') return undefined;
    const effort = writes.find((write) => write.path === 'output_config.effort')?.value;
    return effort === 'xhigh' || effort === 'max' ? 'bedrock-invoke' : 'bedrock-eventstream';
  }
  const expected = profile.compatibility?.transport
    ?? (profile.validatedTransports.includes('compat') && !profile.validatedTransports.includes('rest') ? 'compat' : 'rest');
  if (transport === 'aig-legacy-compat') return expected === 'compat' ? 'compat' : undefined;
  return transport === undefined || transport === expected ? expected : undefined;
}

/** Exact per-profile coverage is necessary, not sufficient, authority: callers
 * still enforce canonical profile refs, server receipts and target identity.
 * Cache and streaming observations do not gate tools + exact replay activation. */
export function capabilityEvidenceMatches(evidence: CapabilitySummary | undefined, profile: NormalizedReasoningProfile, transport?: string): boolean {
  if (!evidence || !profile.enabled) return false;
  let parsed: CapabilitySummary;
  try { parsed = parseCapabilitySummary(evidence); } catch { return false; }
  if (parsed.schemaVersion === 1) return legacyCapabilityQualifies(parsed);
  if (isGeneratedNativeProfileId(profile.id) && !isCanonicalNativeDiscoveryProfile(profile)) return false;
  const groups = new Map<string, { levels: PiReasoningLevel[]; writes: ScalarWrite[] }>();
  if (profile.reasoningMode === 'provider-default') {
    if (profile.supportedLevels.length || Object.keys(profile.levels).length || Object.keys(profile.aliases).length) return false;
    groups.set('default', { levels: [], writes: [] });
  } else {
    if (!profile.supportedLevels.length || new Set(profile.supportedLevels).size !== profile.supportedLevels.length
      || Object.keys(profile.levels).length !== profile.supportedLevels.length) return false;
    for (const level of profile.supportedLevels) {
      const writes = profile.levels[level];
      if (!writes?.length) return false;
      const key = canonicalJson([...writes].sort((a, b) => a.path.localeCompare(b.path)));
      const group = groups.get(key) ?? { levels: [], writes };
      group.levels.push(level);
      groups.set(key, group);
    }
  }
  if (parsed.mappings.length !== groups.size) return false;
  return [...groups.values()].every(({ levels, writes }) => {
    const row = parsed.mappings.find((item) => item.levels.length === levels.length && levels.every((level) => item.levels.includes(level)));
    if (!row?.tools || !row.replay || row.transport !== mappingTransport(profile, writes, transport)) return false;
    if (levels.length === 0) return row.reasoning === 'provider-default';
    if (levels.includes('off')) return levels.length === 1 && literalOff(profile) && row.reasoning === 'verified-disabled';
    return row.reasoning === 'observed-enabled' || row.reasoning === 'accepted-unverified';
  });
}
