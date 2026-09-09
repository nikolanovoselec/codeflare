import { z } from 'zod';
import { canonicalJson, getBuiltInProfileRef, type ProfileRevisionRef } from './reasoning-profiles';
import type { GatewayConnection } from './ai-gateway-management';
import { connectionFingerprint } from './reasoning-verification';

export const BEDROCK_PROFILE_ID = 'bedrock-anthropic-compat';
export const BEDROCK_COMPAT_ADAPTER_VERSION = 'bedrock-anthropic-compat-v1';
const NATIVE_MODEL_MAX_TOKENS = 16_384;

const nativeModelSchema = z.string().trim().min(1).max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .refine((value) => !value.includes('..') && !['__proto__', 'prototype', 'constructor'].includes(value.toLowerCase()));
const labelSchema = z.string().trim().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const profileRefSchema = z.object({ id: z.string().min(1).max(64), revision: z.number().int().positive(), hash: hashSchema }).strict();

export const nativeTargetDraftSchema = z.object({
  id: z.string().uuid().optional(), label: labelSchema, model: nativeModelSchema,
  contextWindow: z.number().int().gt(NATIVE_MODEL_MAX_TOKENS).max(4_000_000),
  profileId: z.literal(BEDROCK_PROFILE_ID), enabled: z.boolean(),
}).strict();
type NativeTargetDraft = z.infer<typeof nativeTargetDraftSchema>;

const nativeVerificationSchema = z.object({
  schemaVersion: z.literal(1), method: z.literal('administrator').optional(), targetId: z.string().uuid(),
  model: nativeModelSchema, providerConfigId: z.string().min(1).max(128), connectionFingerprint: hashSchema,
  profileRef: profileRefSchema, transport: z.literal('aig-legacy-compat'), adapterVersion: z.literal(BEDROCK_COMPAT_ADAPTER_VERSION),
  checkedAt: z.string().datetime(), capabilities: z.object({ streaming: z.literal(true), tools: z.literal(true), replay: z.literal(true) }).strict().optional(),
}).strict();
export type NativeTargetVerification = z.infer<typeof nativeVerificationSchema>;

const targetSchema = z.object({
  id: z.string().uuid(), label: labelSchema, model: nativeModelSchema,
  contextWindow: z.number().int().gt(NATIVE_MODEL_MAX_TOKENS).max(4_000_000), provider: z.literal('aws-bedrock'),
  providerConfigId: z.string().min(1).max(128), transport: z.literal('aig-legacy-compat'), profileRef: profileRefSchema,
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

export function createNativeTarget(input: { id?: string; label: string; model: string; contextWindow: number; providerConfigId: string; profileRef: ProfileRevisionRef; enabled?: boolean }): NativeAiTarget {
  return targetSchema.parse({ id: input.id ?? crypto.randomUUID(), label: input.label, model: input.model, contextWindow: input.contextWindow,
    provider: 'aws-bedrock', providerConfigId: input.providerConfigId, transport: 'aig-legacy-compat', profileRef: input.profileRef, enabled: input.enabled ?? false });
}

export function reconcileNativeTargets(input: unknown, current: NativeAiTargetsDocument, providerConfigId: string, profileRef: ProfileRevisionRef, authorizedNewIds: ReadonlySet<string> = new Set()): NativeAiTargetsDocument {
  const drafts = z.array(nativeTargetDraftSchema).max(64).parse(input);
  const seen = new Set<string>();
  return documentSchema.parse({ schemaVersion: 1, targets: drafts.map((draft) => {
    if (draft.id && seen.has(draft.id)) throw new Error('native target IDs must be unique');
    if (draft.id) seen.add(draft.id);
    const prior = draft.id ? current.targets.find((target) => target.id === draft.id) : undefined;
    const id = prior?.id ?? (draft.id && authorizedNewIds.has(draft.id) ? draft.id : undefined);
    const target = createNativeTarget({ ...draft, id, providerConfigId: prior?.providerConfigId ?? providerConfigId, profileRef });
    const same = prior && prior.model === target.model && prior.providerConfigId === target.providerConfigId
      && prior.providerConfigId === providerConfigId && prior.transport === target.transport && canonicalJson(prior.profileRef) === canonicalJson(target.profileRef);
    return { ...target, ...(same && prior.verification && { verification: prior.verification }) };
  }) });
}

export function nativeVerificationMatches(target: NativeAiTarget, connection: GatewayConnection): boolean {
  const proof = target.verification;
  const fingerprint = connectionFingerprint(connection);
  const currentProfile = getBuiltInProfileRef(BEDROCK_PROFILE_ID);
  return Boolean(proof && fingerprint
    && canonicalJson(target.profileRef) === canonicalJson(currentProfile) && proof.targetId === target.id && proof.model === target.model
    && proof.providerConfigId === target.providerConfigId && proof.connectionFingerprint === fingerprint
    && canonicalJson(proof.profileRef) === canonicalJson(target.profileRef) && proof.transport === target.transport
    && proof.adapterVersion === BEDROCK_COMPAT_ADAPTER_VERSION);
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
  return { id: target.id, handle: nativeTargetHandle(target.id), label: target.label, model: target.model, contextWindow: target.contextWindow,
    provider: target.provider, transport: target.transport, profileRef: target.profileRef, enabled: target.enabled,
    ...(target.verification && { verification: { method: target.verification.method ?? 'automated', checkedAt: target.verification.checkedAt, current } }) };
}
