import type { InferenceDiagnosticContext, InferencePrivateArchiveSink } from './inference-diagnostics';

export interface InferenceArchiveBinding {
  activityId: string;
  generation: number;
  ownerKey: string;
  receiptDigest: string;
}
export type InferenceArchiveFactory = (input: { props: InferenceArchiveBinding & { rawOnly: true } }) => InferencePrivateArchiveSink;

/** ctx.props requires persistent values: use the existing Service Binding, not an ephemeral RpcTarget. */
export function inferenceArchiveCapability(context: InferenceDiagnosticContext | undefined,
  identity: Pick<InferenceArchiveBinding, 'ownerKey' | 'receiptDigest'>, create: InferenceArchiveFactory) {
  return context?.privateArchive && context.loggingEnabled !== false ? create({ props: {
    activityId: context.activityId, generation: context.generation, ...identity, rawOnly: true,
  } }) : undefined;
}
