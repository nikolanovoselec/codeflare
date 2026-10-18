/**
 * Fresh Worker construction adapter
 * The small binding interface describes the platform API; the function below supplies explicit code,
 * capability and outbound bindings. Artifact approval and authorization must already be complete.
 * This file owns no durable state, inherited credentials, isolate cache or effect reconciliation.
 * See sdd/spec/operators.md and documentation/lanes/operators.md for acceptance boundaries.
 */
import type { DispatcherBundle, OperatorBundle } from './distribution';
import { DEFAULT_SOURCE_RESPONSE_BYTES } from './dispatcher-source-limits';
import { DEFAULT_SUBMISSION_ATTEMPT_LIMIT } from './dispatcher-submission-limits';

/** Minimal documented Worker Loader surface; no cached get() or inherited env. */
interface OperatorLoaderCode {
  compatibilityDate: string;
  compatibilityFlags: string[];
  mainModule: string;
  modules: OperatorBundle['modules'];
  env: { OPERATOR: Fetcher; GITHUB_API_ORIGIN?: string; OPERATOR_SOURCE_RESPONSE_BYTES?: string;
    OPERATOR_ADMITTED_TARGET?: string; OPERATOR_LOGGING_ENABLED?: string; OPERATOR_SUBMISSION_ATTEMPT_LIMIT?: string };
  globalOutbound: Fetcher | null;
  tails?: Array<{ tail(events: unknown): Promise<void> }>;
}

export interface OperatorLoaderBinding {
  load(code: OperatorLoaderCode): { getEntrypoint(): Fetcher };
}
export interface OperatorDispatcherLoaderBinding {
  get(id: string, code: () => Promise<OperatorLoaderCode>): { getDurableObjectClass(name: string): unknown };
}

/**
 * REQ-OPERATOR-015: Instantiate approved code in a fresh Worker with only the
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

/**
 * REQ-OPERATOR-048: Select only the approved generated Flue class. The Loader
 * cache identity captures activity, immutable source and generation so a warmed
 * generation can never be rebound to newer authority. Direct outbound is denied.
 */
export function loadOperatorDispatcherClass(
  loader: OperatorDispatcherLoaderBinding,
  bundle: DispatcherBundle,
  artifactDigest: string,
  activityId: string,
  generation: number,
  capability: Fetcher,
  tail: { tail(events: unknown): Promise<void> },
  outbound: Fetcher | null = null,
  githubApiOrigin?: string,
  sourceBytes = DEFAULT_SOURCE_RESPONSE_BYTES,
  admittedTargetJson?: string,
  loggingEnabled = true,
  submissionAttemptLimit = DEFAULT_SUBMISSION_ATTEMPT_LIMIT,
): unknown {
  if (!/^[0-9a-f]{64}$/.test(artifactDigest) || !/^[A-Za-z0-9_-]{1,128}$/.test(activityId)
    || !Number.isSafeInteger(generation) || generation < 1
    || !Number.isSafeInteger(submissionAttemptLimit) || submissionAttemptLimit < 1) {
    throw new Error('Dispatcher Loader authority is invalid');
  }
  return loader.get(`dispatcher:${activityId}:${artifactDigest}:${generation}`, async () => ({
    compatibilityDate: bundle.compatibilityDate,
    compatibilityFlags: bundle.compatibilityFlags,
    mainModule: bundle.mainModule,
    modules: bundle.modules,
    env: { OPERATOR: capability, OPERATOR_SUBMISSION_ATTEMPT_LIMIT: String(submissionAttemptLimit), ...(githubApiOrigin ? { GITHUB_API_ORIGIN: githubApiOrigin,
      OPERATOR_SOURCE_RESPONSE_BYTES: String(sourceBytes) } : {}),
      ...(admittedTargetJson !== undefined ? { OPERATOR_ADMITTED_TARGET: admittedTargetJson } : {}),
      ...(loggingEnabled ? {} : { OPERATOR_LOGGING_ENABLED: 'false' }) },
    globalOutbound: outbound,
    tails: [tail],
  })).getDurableObjectClass(bundle.className);
}
