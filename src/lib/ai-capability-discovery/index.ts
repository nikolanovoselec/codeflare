import { discoverPiCompatibility, type DiscoveryInput } from '../reasoning-discovery';
import { BEDROCK_MESSAGES_DEFAULT_PROFILE } from '../native-ai-target-draft';
import type { TargetCapabilityResult } from './contract';
import { MAX_CAPABILITY_SUBMISSIONS } from './contract';
export type { TargetCapabilityResult } from './contract';
import { canonicalHash, getBuiltInProfile, normalizeCustomProfile, type NormalizedReasoningProfile } from '../reasoning-profiles';

export type TargetCapabilityInput = Omit<DiscoveryInput, 'profile' | 'offCandidateMapping' | 'requireCacheEvidence' | 'endpoint' | 'campaignDeadline'>;

/** These are audited request *forms*, not model capability assertions. Existing
 * profiles supply the finite protocol vocabulary; their model labels/provenance
 * do not participate in selection. A newly named model uses the same probes.
 * Native currently implements only the observed Bedrock Messages boundary;
 * adding Azure would mean a deliberate protocol extension, not URL guessing. */
export function capabilityCandidates(native: boolean): NormalizedReasoningProfile[] {
  if (native) return [getBuiltInProfile(BEDROCK_MESSAGES_DEFAULT_PROFILE)!];
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

/** One explicit administrator action, no selection/startup/background probes.
 * Failures never trigger model/provider substitutions or production retries.
 * Search is bounded independently of the growing profile/model catalog. */
export async function discoverTargetCapabilities(input: TargetCapabilityInput): Promise<TargetCapabilityResult> {
  if (!input.native && !input.route.startsWith('dynamic/') && !input.route.startsWith('aws-bedrock/')) {
    throw new TypeError('Native discovery supports the observed Bedrock contract only; this protocol is not supported');
  }
  const attempts: TargetCapabilityResult['attempts'] = [];
  let count = 0;
  let cacheInconclusive = false;
  let refusalExplanation: string | undefined;
  let stopped = false;
  const started = Date.now();
  const fetcher = input.fetcher ?? input.fetchImpl ?? fetch;
  const boundedFetch: typeof fetch = async (url, init) => {
    if (count >= MAX_CAPABILITY_SUBMISSIONS || Date.now() - started >= 10 * 60_000) throw new Error('capability_campaign_limit');
    count++;
    return fetcher(url, init);
  };
  for (const profile of capabilityCandidates(Boolean(input.native))) {
    const countBefore = count;
    const report = await discoverPiCompatibility({ ...input, profile, fetcher: boundedFetch, campaignDeadline: started + 10 * 60_000,
      maxCompletionTokens: Math.min(input.maxCompletionTokens, 2048), timeoutMs: Math.min(input.timeoutMs ?? 90_000, 90_000), requireCacheEvidence: true });
    attempts.push({ contract: profile.id, classification: report.classification, capabilities: report.capabilitySummary,
      diagnostics: report.diagnostics ?? [], httpAttempts: count - countBefore });
    cacheInconclusive ||= report.capabilitySummary?.cache === 'inconclusive';
    if (report.diagnostics?.some((item: { code: string; stage: string }) => item.code === 'provider_refusal' && item.stage === 'cache-fill')) {
      refusalExplanation = report.cacheEvidence?.explanation;
    }
    if (report.assignable && !report.stopDiscovery) return { schemaVersion: 1, assignable: true, classification: 'Verified',
      explanation: 'One working configuration was selected automatically. Review and Save to enable it; only this exercised target path is certified.',
      capabilities: report.capabilitySummary, profile, report, attempts, accounting: { httpAttempts: count } };
    if (report.stopDiscovery || count >= MAX_CAPABILITY_SUBMISSIONS || Date.now() - started >= 10 * 60_000) { stopped = true; break; }
  }
  // A bounded campaign cannot prove universal provider impossibility. In
  // particular, misses and model refusals are not "caching unsupported".
  return { schemaVersion: 1, assignable: false, classification: 'Inconclusive',
    explanation: refusalExplanation ?? (stopped ? 'Discovery stopped at an authentication, provider, framing, timeout or campaign boundary. Tools/replay and cache minimum was not established; inspect the stage/status diagnostics.'
      : cacheInconclusive ? 'Tool calling/replay worked, but no qualifying cache reuse was observed with the supported contracts. Minimum is inconclusive, not proof that caching is unsupported.'
        : 'No tested protocol contract completed the required tool lifecycle and caching. This target cannot be enabled by discovery; the failed stages explain what is missing.'),
    attempts, accounting: { httpAttempts: count } };
}
