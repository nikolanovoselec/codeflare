import { z } from 'zod';
import { canonicalJson, type ProfileRevisionRef, type ReasoningProfileId } from './reasoning-profiles';
import type { GatewayConnection } from './ai-gateway-management';
import { connectionFingerprint } from './reasoning-verification';

export const BEDROCK_PROFILE_ID = 'bedrock-anthropic-compat';
export const OPENAI_NATIVE_PROFILE_ID = 'native-openai-compat';
export const GEMINI_NATIVE_PROFILE_ID = 'native-google-ai-studio-compat';
export const MESH_NATIVE_PROFILE_ID = 'native-codeflare-inference-mesh-compat';
export const BEDROCK_COMPAT_ADAPTER_VERSION = 'bedrock-anthropic-compat-v1';
export const NATIVE_COMPAT_ADAPTER_VERSION = 'native-openai-compat-v1';
export const GEMINI_COMPAT_ADAPTER_VERSION = 'gemini-openai-compat-v1';
const NATIVE_MODEL_MAX_TOKENS = 16_384;

const nativeModelSchema = z.string().trim().min(1).max(256)
  .regex(/^[A-Za-z0-9@][A-Za-z0-9@._:/-]*$/)
  .refine((value) => !value.includes('..') && !['__proto__', 'prototype', 'constructor'].includes(value.toLowerCase()));
const providerSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
  .refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value));
const providerAliasSchema = z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/);
const labelSchema = z.string().trim().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const nativeProfileRefSchema = z.object({ id: z.string().min(1).max(64), revision: z.number().int().positive(), hash: hashSchema }).strict();
const adapterVersionSchema = z.enum([BEDROCK_COMPAT_ADAPTER_VERSION, NATIVE_COMPAT_ADAPTER_VERSION, GEMINI_COMPAT_ADAPTER_VERSION]);

export function defaultNativeProfileId(provider: string): ReasoningProfileId {
  if (provider === 'aws-bedrock') return BEDROCK_PROFILE_ID;
  if (provider === 'google-ai-studio') return GEMINI_NATIVE_PROFILE_ID;
  if (provider === 'openai') return OPENAI_NATIVE_PROFILE_ID;
  return MESH_NATIVE_PROFILE_ID;
}
export function nativeTargetAdapterVersion(provider: string): typeof BEDROCK_COMPAT_ADAPTER_VERSION | typeof NATIVE_COMPAT_ADAPTER_VERSION | typeof GEMINI_COMPAT_ADAPTER_VERSION {
  return provider === 'aws-bedrock' ? BEDROCK_COMPAT_ADAPTER_VERSION : provider === 'google-ai-studio' ? GEMINI_COMPAT_ADAPTER_VERSION : NATIVE_COMPAT_ADAPTER_VERSION;
}
export function nativeProviderSelector(provider: string, customProvider = false): string {
  const slug = providerSchema.parse(provider);
  return customProvider ? `custom-${slug}` : slug;
}
export function nativeProfileRefKey(ref: ProfileRevisionRef): string { return `${ref.id}\u001f${ref.revision}\u001f${ref.hash}`; }

export const nativeTargetDraftSchema = z.object({
  id: z.string().uuid().optional(), label: labelSchema, model: nativeModelSchema,
  contextWindow: z.number().int().gt(NATIVE_MODEL_MAX_TOKENS).max(4_000_000),
  provider: providerSchema.default('aws-bedrock'), profileRef: nativeProfileRefSchema, enabled: z.boolean(),
}).strict();
const nativeVerificationSchema = z.object({
  schemaVersion: z.literal(1), method: z.literal('administrator').optional(), targetId: z.string().uuid(),
  provider: providerSchema.optional(), customProvider: z.boolean().optional(), model: nativeModelSchema,
  providerConfigId: z.string().min(1).max(128), providerConfigAlias: providerAliasSchema.optional(), connectionFingerprint: hashSchema,
  profileRef: nativeProfileRefSchema, transport: z.literal('aig-legacy-compat'), adapterVersion: adapterVersionSchema,
  checkedAt: z.string().datetime(), capabilities: z.object({ streaming: z.literal(true), tools: z.literal(true), replay: z.literal(true) }).strict().optional(),
}).strict();
export type NativeTargetVerification = z.infer<typeof nativeVerificationSchema>;

const targetSchema = z.object({
  id: z.string().uuid(), label: labelSchema, model: nativeModelSchema,
  contextWindow: z.number().int().gt(NATIVE_MODEL_MAX_TOKENS).max(4_000_000), provider: providerSchema.default('aws-bedrock'),
  customProvider: z.boolean().optional(), providerConfigId: z.string().min(1).max(128), providerConfigAlias: providerAliasSchema.optional(),
  transport: z.literal('aig-legacy-compat'), profileRef: nativeProfileRefSchema,
  enabled: z.boolean(), verification: nativeVerificationSchema.optional(),
}).strict();
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
}): NativeAiTarget {
  return targetSchema.parse({
    id: input.id ?? crypto.randomUUID(), label: input.label, model: input.model, contextWindow: input.contextWindow,
    provider: input.provider ?? 'aws-bedrock', ...(input.customProvider && { customProvider: true }), providerConfigId: input.providerConfigId,
    ...(input.providerConfigAlias && { providerConfigAlias: input.providerConfigAlias }), transport: 'aig-legacy-compat',
    profileRef: input.profileRef, enabled: input.enabled ?? false,
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
      && prior.transport === target.transport && canonicalJson(prior.profileRef) === canonicalJson(target.profileRef);
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
    && canonicalJson(proof.profileRef) === canonicalJson(target.profileRef) && proof.transport === target.transport
    && proof.adapterVersion === nativeTargetAdapterVersion(target.provider));
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
    provider: target.provider, transport: target.transport, profileRef: target.profileRef, enabled: target.enabled,
    ...(target.verification && { verification: { method: target.verification.method ?? 'automated', checkedAt: target.verification.checkedAt, current } }),
  };
}
