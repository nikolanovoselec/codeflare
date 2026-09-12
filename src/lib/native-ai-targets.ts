import { z } from 'zod';
import { canonicalJson, type ProfileRevisionRef, type ReasoningProfileId } from './reasoning-profiles';
import type { GatewayConnection } from './ai-gateway-management';
import { connectionFingerprint } from './reasoning-verification';
import {
  NATIVE_CONTEXT_WINDOW_MAX,
  NATIVE_HASH_PATTERN,
  NATIVE_MODEL_MAX_TOKENS,
  NATIVE_MODEL_PATTERN,
  NATIVE_PROVIDER_PATTERN,
  NATIVE_REGION_PATTERN,
  NATIVE_TEXT_PATTERN,
  NATIVE_TRANSPORTS,
  nativeModelIdentifierValid,
  nativeProviderIdentifierValid,
  nativeProviderModelValid,
  nativeTargetDraftShapeValid,
} from './native-ai-target-draft';

const BEDROCK_PROFILE_ID = 'bedrock-anthropic-compat';
const OPENAI_NATIVE_PROFILE_ID = 'native-openai-compat';
const GEMINI_NATIVE_PROFILE_ID = 'native-google-ai-studio-compat';
const MESH_NATIVE_PROFILE_ID = 'native-codeflare-inference-mesh-compat';
export const BEDROCK_COMPAT_ADAPTER_VERSION = 'bedrock-anthropic-compat-v1';
// Checkpoint translation changes the paid request contract. A v1 receipt proves
// neither its acceptance nor cache-aware tool replay; require explicit administrator
// reconfirmation of the new recorded evidence (the existing native authority flow),
// never rewrite existing receipts or silently convert a saved compat transport.
export const BEDROCK_NATIVE_ADAPTER_VERSION = 'bedrock-anthropic-native-v2';
export const NATIVE_COMPAT_ADAPTER_VERSION = 'native-openai-compat-v1';
export const GEMINI_COMPAT_ADAPTER_VERSION = 'gemini-openai-compat-v1';

const nativeModelSchema = z.string().trim().min(1).max(256).regex(NATIVE_MODEL_PATTERN).refine(nativeModelIdentifierValid);
function enforceProviderModel(value: { provider?: string; model: string }, context: z.RefinementCtx): void {
  if (nativeModelIdentifierValid(value.model) && !nativeProviderModelValid(value.provider ?? 'aws-bedrock', value.model)) {
    context.addIssue({ code: 'custom', message: 'Bedrock model identifiers cannot be URLs, paths, or ARNs', path: ['model'] });
  }
}
const providerSchema = z.string().regex(NATIVE_PROVIDER_PATTERN).refine(nativeProviderIdentifierValid);
const providerAliasSchema = z.string().min(1).max(128).regex(NATIVE_TEXT_PATTERN);
function enforceNativeTransport(value: { provider?: string; model: string; transport?: string; region?: string; profileRef?: ProfileRevisionRef }, context: z.RefinementCtx): void {
  const transport = value.transport ?? 'aig-legacy-compat';
  const native = transport !== 'aig-legacy-compat';
  if (native && (value.provider ?? 'aws-bedrock') !== 'aws-bedrock') context.addIssue({ code: 'custom', message: 'provider-native Bedrock transports require aws-bedrock', path: ['transport'] });
  if (native && !value.region) context.addIssue({ code: 'custom', message: 'provider-native Bedrock transports require a region', path: ['region'] });
  if (!native && value.region) context.addIssue({ code: 'custom', message: 'compatibility transports do not accept a Bedrock region', path: ['region'] });
  const profileId = value.profileRef?.id;
  if (!profileId) return;
  const nativeProfile = profileId.startsWith('bedrock-anthropic-native-');
  if (native !== nativeProfile) context.addIssue({ code: 'custom', message: 'Bedrock native profiles and transports must be selected together', path: ['profileRef'] });
  if (profileId === 'bedrock-anthropic-native-sonnet' && !value.model.includes('.claude-sonnet-5')) context.addIssue({ code: 'custom', message: 'Sonnet profile requires a Claude Sonnet 5 model', path: ['model'] });
  if (profileId.startsWith('bedrock-anthropic-native-opus-') && !value.model.includes('.claude-opus-5')) context.addIssue({ code: 'custom', message: 'Opus profile requires a Claude Opus 5 model', path: ['model'] });
  if (profileId === 'bedrock-anthropic-native-opus-stream' && transport !== 'aig-bedrock-anthropic-eventstream') context.addIssue({ code: 'custom', message: 'Opus streaming profile requires eventstream transport', path: ['transport'] });
  if (profileId === 'bedrock-anthropic-native-opus-invoke' && transport !== 'aig-bedrock-anthropic-invoke') context.addIssue({ code: 'custom', message: 'Opus Invoke profile requires Invoke transport', path: ['transport'] });
  if (profileId === 'bedrock-anthropic-native-opus-auto' && transport !== 'aig-bedrock-anthropic-auto') context.addIssue({ code: 'custom', message: 'Opus automatic profile requires automatic transport', path: ['transport'] });
  if (transport === 'aig-bedrock-anthropic-auto' && profileId !== 'bedrock-anthropic-native-sonnet' && profileId !== 'bedrock-anthropic-native-opus-auto') context.addIssue({ code: 'custom', message: 'Automatic transport requires a validated automatic Bedrock profile', path: ['profileRef'] });
}
const labelSchema = z.string().trim().min(1).max(128).regex(NATIVE_TEXT_PATTERN);
const hashSchema = z.string().regex(NATIVE_HASH_PATTERN);
const nativeProfileRefSchema = z.object({ id: z.string().min(1).max(64), revision: z.number().int().positive(), hash: hashSchema }).strict();
const transportSchema = z.enum(NATIVE_TRANSPORTS);
const regionSchema = z.string().regex(NATIVE_REGION_PATTERN);
const nativeTargetDraftObjectSchema = z.object({
  id: z.string().uuid().optional(), label: labelSchema, model: nativeModelSchema,
  contextWindow: z.number().int().gt(NATIVE_MODEL_MAX_TOKENS).max(NATIVE_CONTEXT_WINDOW_MAX),
  provider: providerSchema.default('aws-bedrock'), profileRef: nativeProfileRefSchema, enabled: z.boolean(),
  transport: transportSchema.optional(), region: regionSchema.optional(),
}).strict();
export const nativeTargetDraftSchema = nativeTargetDraftObjectSchema
  .refine(nativeTargetDraftShapeValid, { message: 'native target draft is invalid' })
  .superRefine(enforceProviderModel).superRefine(enforceNativeTransport);
export const nativeTargetProfileDiscoveryDraftSchema = nativeTargetDraftObjectSchema
  .extend({ profileRef: nativeProfileRefSchema.optional() }).superRefine(enforceProviderModel).superRefine(enforceNativeTransport);
// Retain old documents for display/reverification; v1 receipts do not authorize
// the new prompt-cache request mapping checked by nativeVerificationMatches.
const adapterVersionSchema = z.enum([BEDROCK_COMPAT_ADAPTER_VERSION, 'bedrock-anthropic-native-v1', BEDROCK_NATIVE_ADAPTER_VERSION, NATIVE_COMPAT_ADAPTER_VERSION, GEMINI_COMPAT_ADAPTER_VERSION]);

export function defaultNativeProfileId(provider: string): ReasoningProfileId {
  if (provider === 'aws-bedrock') return BEDROCK_PROFILE_ID;
  if (provider === 'google-ai-studio') return GEMINI_NATIVE_PROFILE_ID;
  if (provider === 'openai') return OPENAI_NATIVE_PROFILE_ID;
  return MESH_NATIVE_PROFILE_ID;
}
export function nativeTargetAdapterVersion(provider: string, transport = 'aig-legacy-compat'): typeof BEDROCK_COMPAT_ADAPTER_VERSION | typeof BEDROCK_NATIVE_ADAPTER_VERSION | typeof NATIVE_COMPAT_ADAPTER_VERSION | typeof GEMINI_COMPAT_ADAPTER_VERSION {
  if (provider === 'aws-bedrock') return transport === 'aig-legacy-compat' ? BEDROCK_COMPAT_ADAPTER_VERSION : BEDROCK_NATIVE_ADAPTER_VERSION;
  return provider === 'google-ai-studio' ? GEMINI_COMPAT_ADAPTER_VERSION : NATIVE_COMPAT_ADAPTER_VERSION;
}
export function nativeProviderSelector(provider: string, customProvider = false): string {
  const slug = providerSchema.parse(provider);
  return customProvider ? `custom-${slug}` : slug;
}
export function nativeProfileRefKey(ref: ProfileRevisionRef): string { return `${ref.id}\u001f${ref.revision}\u001f${ref.hash}`; }

const nativeVerificationSchema = z.object({
  schemaVersion: z.literal(1), method: z.literal('administrator').optional(), targetId: z.string().uuid(),
  provider: providerSchema.optional(), customProvider: z.boolean().optional(), model: nativeModelSchema,
  providerConfigId: z.string().min(1).max(128), providerConfigAlias: providerAliasSchema.optional(), connectionFingerprint: hashSchema,
  profileRef: nativeProfileRefSchema, transport: transportSchema, region: regionSchema.optional(), adapterVersion: adapterVersionSchema,
  checkedAt: z.string().datetime(), capabilities: z.object({ streaming: z.literal(true), tools: z.literal(true), replay: z.literal(true) }).strict().optional(),
}).strict().superRefine(enforceProviderModel).superRefine(enforceNativeTransport);
export type NativeTargetVerification = z.infer<typeof nativeVerificationSchema>;

const targetSchema = z.object({
  id: z.string().uuid(), label: labelSchema, model: nativeModelSchema,
  contextWindow: z.number().int().gt(NATIVE_MODEL_MAX_TOKENS).max(NATIVE_CONTEXT_WINDOW_MAX), provider: providerSchema.default('aws-bedrock'),
  customProvider: z.boolean().optional(), providerConfigId: z.string().min(1).max(128), providerConfigAlias: providerAliasSchema.optional(),
  transport: transportSchema, region: regionSchema.optional(), profileRef: nativeProfileRefSchema,
  enabled: z.boolean(), verification: nativeVerificationSchema.optional(),
}).strict().superRefine(enforceProviderModel).superRefine(enforceNativeTransport);
export type NativeAiTarget = z.infer<typeof targetSchema>;

const documentSchema = z.object({ schemaVersion: z.literal(1), targets: z.array(targetSchema).max(64) }).strict().superRefine((value, context) => {
  const ids = value.targets.map((target) => target.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: 'native target IDs must be unique' });
});
export type NativeAiTargetsDocument = z.infer<typeof documentSchema>;

const checkReceiptSchema = z.object({ targetId: z.string().uuid(), verification: nativeVerificationSchema }).strict();
const CHECK_PREFIX = 'admin:native-ai-target-check:';
const CHECK_TTL_SECONDS = 900;

export interface NativeProviderAuthority { id: string; alias?: string; customProvider: boolean }

export function nativeTargetHandle(id: string): string { return `cf-native-${z.string().uuid().parse(id)}`; }
export function nativeTargetIdFromHandle(handle: string): string | null {
  const parsed = z.string().uuid().safeParse(handle.startsWith('cf-native-') ? handle.slice('cf-native-'.length) : '');
  return parsed.success ? parsed.data : null;
}

export function parseNativeAiTargets(value: unknown): NativeAiTargetsDocument {
  if (value === null || value === undefined || value === '') return { schemaVersion: 1, targets: [] };
  return documentSchema.parse(typeof value === 'string' ? JSON.parse(value) : value);
}
export function serializeNativeAiTargets(value: unknown): string { return canonicalJson(parseNativeAiTargets(value)); }

export function createNativeTarget(input: {
  id?: string; label: string; model: string; contextWindow: number; provider?: string; customProvider?: boolean;
  providerConfigId: string; providerConfigAlias?: string; profileRef: ProfileRevisionRef; enabled?: boolean;
  transport?: typeof NATIVE_TRANSPORTS[number]; region?: string;
}): NativeAiTarget {
  return targetSchema.parse({
    id: input.id ?? crypto.randomUUID(), label: input.label, model: input.model, contextWindow: input.contextWindow,
    provider: input.provider ?? 'aws-bedrock', ...(input.customProvider && { customProvider: true }), providerConfigId: input.providerConfigId,
    ...(input.providerConfigAlias && { providerConfigAlias: input.providerConfigAlias }), transport: input.transport ?? 'aig-legacy-compat',
    ...(input.region && { region: input.region }), profileRef: input.profileRef, enabled: input.enabled ?? false,
  });
}

export function reconcileNativeTargets(
  input: unknown,
  current: NativeAiTargetsDocument,
  authorities: Readonly<Record<string, NativeProviderAuthority>>,
  validProfileRefs: ReadonlySet<string>,
  authorizedNewIds: ReadonlySet<string> = new Set(),
): NativeAiTargetsDocument {
  const drafts = z.array(nativeTargetDraftSchema).max(64).parse(input);
  const seen = new Set<string>();
  return documentSchema.parse({ schemaVersion: 1, targets: drafts.map((draft) => {
    if (draft.id && seen.has(draft.id)) throw new Error('native target IDs must be unique');
    if (draft.id) seen.add(draft.id);
    const authority = authorities[draft.provider];
    if (!authority) throw new Error(`Native provider ${draft.provider} is unavailable or ambiguous`);
    if (!validProfileRefs.has(nativeProfileRefKey(draft.profileRef))) throw new Error('Native target profile revision not found');
    const prior = draft.id ? current.targets.find((target) => target.id === draft.id) : undefined;
    const id = prior?.id ?? (draft.id && authorizedNewIds.has(draft.id) ? draft.id : undefined);
    const preserveBinding = prior?.provider === draft.provider;
    const target = createNativeTarget({
      ...draft, id, customProvider: preserveBinding ? prior.customProvider : authority.customProvider,
      providerConfigId: preserveBinding ? prior.providerConfigId : authority.id,
      providerConfigAlias: preserveBinding ? prior.providerConfigAlias : authority.alias,
    });
    const same = prior && prior.provider === target.provider && Boolean(prior.customProvider) === Boolean(target.customProvider)
      && prior.model === target.model && prior.providerConfigId === target.providerConfigId && prior.providerConfigId === authority.id
      && prior.providerConfigAlias === target.providerConfigAlias && target.providerConfigAlias === authority.alias
      && prior.transport === target.transport && prior.region === target.region && canonicalJson(prior.profileRef) === canonicalJson(target.profileRef);
    return { ...target, ...(same && prior.verification && { verification: prior.verification }) };
  }) });
}

export function nativeVerificationMatches(target: NativeAiTarget, connection: GatewayConnection): boolean {
  const proof = target.verification;
  const fingerprint = connectionFingerprint(connection);
  return Boolean(proof && fingerprint && proof.targetId === target.id
    && (proof.provider ?? 'aws-bedrock') === target.provider && Boolean(proof.customProvider) === Boolean(target.customProvider)
    && proof.model === target.model && proof.providerConfigId === target.providerConfigId
    && proof.providerConfigAlias === target.providerConfigAlias && proof.connectionFingerprint === fingerprint
    && canonicalJson(proof.profileRef) === canonicalJson(target.profileRef) && proof.transport === target.transport && proof.region === target.region
    && proof.adapterVersion === nativeTargetAdapterVersion(target.provider, target.transport));
}

export function rebindNativeVerificationConnection(target: NativeAiTarget, connection: GatewayConnection): NativeTargetVerification | null {
  const proof = target.verification;
  const fingerprint = connectionFingerprint(connection);
  if (!proof || !fingerprint || proof.targetId !== target.id
    || (proof.provider ?? 'aws-bedrock') !== target.provider || Boolean(proof.customProvider) !== Boolean(target.customProvider)
    || proof.model !== target.model || proof.providerConfigId !== target.providerConfigId
    || proof.providerConfigAlias !== target.providerConfigAlias
    || canonicalJson(proof.profileRef) !== canonicalJson(target.profileRef) || proof.transport !== target.transport || proof.region !== target.region
    || proof.adapterVersion !== nativeTargetAdapterVersion(target.provider, target.transport)) return null;
  return { ...proof, connectionFingerprint: fingerprint, checkedAt: new Date().toISOString() };
}

export async function issueNativeTargetCheck(kv: KVNamespace, targetId: string, verification: NativeTargetVerification): Promise<string> {
  const receipt = checkReceiptSchema.parse({ targetId, verification });
  const checkId = crypto.randomUUID();
  await kv.put(`${CHECK_PREFIX}${checkId}`, JSON.stringify(receipt), { expirationTtl: CHECK_TTL_SECONDS });
  return checkId;
}
export async function readNativeTargetCheck(kv: KVNamespace, checkId: string): Promise<z.infer<typeof checkReceiptSchema>> {
  z.string().uuid().parse(checkId);
  const raw = await kv.get(`${CHECK_PREFIX}${checkId}`);
  if (!raw) throw new Error('Native target check receipt unavailable or expired');
  const receipt = checkReceiptSchema.parse(JSON.parse(raw));
  const age = Date.now() - Date.parse(receipt.verification.checkedAt);
  if (age < 0 || age >= CHECK_TTL_SECONDS * 1000) throw new Error('Native target check receipt unavailable or expired');
  return receipt;
}

export function sanitizeNativeTarget(target: NativeAiTarget, current = false): Record<string, unknown> {
  return {
    id: target.id, handle: nativeTargetHandle(target.id), label: target.label, model: target.model, contextWindow: target.contextWindow,
    provider: target.provider, transport: target.transport, ...(target.region && { region: target.region }), profileRef: target.profileRef, enabled: target.enabled,
    ...(target.verification && { verification: { method: target.verification.method ?? 'automated', checkedAt: target.verification.checkedAt, current } }),
  };
}
