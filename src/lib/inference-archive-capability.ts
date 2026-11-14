import { RpcTarget } from 'cloudflare:workers';
import type { InferenceDiagnosticContext } from './inference-diagnostics';

/** Worker-owned capability; the callback is private, never serialized in props. */
class PrivateArchiveTarget extends RpcTarget {
  #archive: NonNullable<InferenceDiagnosticContext['privateArchive']>;
  constructor(archive: NonNullable<InferenceDiagnosticContext['privateArchive']>) { super(); this.#archive = archive; }
  record(stage: string, value: unknown): void {
    if (typeof stage !== 'string') throw new Error('Raw observation unavailable');
    this.#archive(stage, value);
  }
}

export function inferenceArchiveCapability(context: InferenceDiagnosticContext | undefined) {
  return context?.privateArchive && context.loggingEnabled !== false ? new PrivateArchiveTarget(context.privateArchive) : undefined;
}
