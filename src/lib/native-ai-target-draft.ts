import { z } from 'zod';

export const NATIVE_MODEL_MAX_TOKENS = 16_384;

export const nativeModelSchema = z.string().trim().min(1).max(256)
  .regex(/^[A-Za-z0-9@][A-Za-z0-9@._:/-]*$/)
  .refine((value) => !value.includes('..') && !['__proto__', 'prototype', 'constructor'].includes(value.toLowerCase()));
export function enforceProviderModel(value: { provider?: string; model: string }, context: z.RefinementCtx): void {
  if ((value.provider ?? 'aws-bedrock') === 'aws-bedrock' && (value.model.includes('/') || /^arn:/i.test(value.model))) {
    context.addIssue({ code: 'custom', message: 'Bedrock model identifiers cannot be URLs, paths, or ARNs', path: ['model'] });
  }
}
export const providerSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
  .refine((value) => !['__proto__', 'prototype', 'constructor'].includes(value));
export const providerAliasSchema = z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/);
export const labelSchema = z.string().trim().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/);
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const nativeProfileRefSchema = z.object({
  id: z.string().min(1).max(64), revision: z.number().int().positive(), hash: hashSchema,
}).strict();

export const nativeTargetDraftObjectSchema = z.object({
  id: z.string().uuid().optional(), label: labelSchema, model: nativeModelSchema,
  contextWindow: z.number().int().gt(NATIVE_MODEL_MAX_TOKENS).max(4_000_000),
  provider: providerSchema.default('aws-bedrock'), profileRef: nativeProfileRefSchema, enabled: z.boolean(),
}).strict();
export const nativeTargetDraftSchema = nativeTargetDraftObjectSchema.superRefine(enforceProviderModel);
export const nativeTargetProfileDiscoveryDraftSchema = nativeTargetDraftObjectSchema
  .extend({ profileRef: nativeProfileRefSchema.optional() }).superRefine(enforceProviderModel);
