/**
 * Fresh Worker construction adapter
 * The small binding interface describes the platform API; the function below supplies explicit code,
 * capability and outbound bindings. Artifact approval and authorization must already be complete.
 * This file owns no durable state, inherited credentials, isolate cache or effect reconciliation.
 * See sdd/spec/operators.md and documentation/lanes/operators.md for acceptance boundaries.
 */
import type { OperatorBundle } from './distribution';

/** Minimal documented Worker Loader surface; no cached get() or inherited env. */
export interface OperatorLoaderBinding {
  load(code: {
    compatibilityDate: string;
    compatibilityFlags: string[];
    mainModule: string;
    modules: OperatorBundle['modules'];
    env: { OPERATOR: Fetcher };
    globalOutbound: Fetcher | null;
  }): { getEntrypoint(): Fetcher };
}

/**
 * REQ-OPERATOR-003: Instantiate approved code in a fresh Worker with only the
 * parent-owned Operator Interface binding and explicit outbound interception.
 * The caller verifies artifact integrity, current authority and admission first,
 * and creates principal/activity-bound service bindings. No parent environment
 * or credentials are copied. Null outbound denies networking; omission is not
 * supported. Returns the default entrypoint; loader errors propagate, without
 * fallback or retries. The activity owns checkpoints and effect reconciliation,
 * never this isolate. Example: loadOperatorWorker(loader, approved, api, egress).
 */
export function loadOperatorWorker(
  loader: OperatorLoaderBinding,
  bundle: OperatorBundle,
  capability: Fetcher,
  outbound: Fetcher | null,
): Fetcher {
  return loader.load({
    compatibilityDate: bundle.compatibilityDate,
    compatibilityFlags: bundle.compatibilityFlags,
    mainModule: bundle.mainModule,
    modules: bundle.modules,
    env: { OPERATOR: capability },
    globalOutbound: outbound,
  }).getEntrypoint();
}
