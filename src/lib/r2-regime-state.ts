/**
 * Governed Mode (REQ-ENTERPRISE-018) per-bucket R2 encryption-regime STATE — the
 * single source of truth that replaces both the old boolean
 * `UserPreferences.r2SseRegime` marker AND the standalone `r2-migration-lock:` key.
 *
 * Two values drive the SSE-C decision:
 *   - The deployment POLICY (`SETUP_KEYS.R2_SSE_DISABLED`, a wizard toggle): the
 *     regime the admin WANTS every bucket in.
 *   - The per-bucket STATE (`r2-regime:<bucket>`): the regime a bucket's objects are
 *     ACTUALLY stored in right now, plus any in-flight migration. The migration driver
 *     (src/lib/r2-migration.ts) reconciles the state to the policy; until a pass fully
 *     completes + verifies, the state is the truth and every read/write keys off it.
 *
 * A single boolean cannot describe a partially in-place-migrated bucket, so the state
 * carries an explicit status ('ready' | 'migrating' | 'mixed-recovery'), a resumable
 * `cursor`, a `generation` stamped onto containers, and a `leaseExpiresAt` that doubles
 * as the (self-healing) migration lock.
 */
import type { Env, UserPreferences } from '../types';
import { SETUP_KEYS, getRegimeStateKey, getPreferencesKey } from './kv-keys';

export type R2SseRegime = 'sse-c' | 'plain';
/** Internal to the RegimeState shape; not exported (no external consumer — knip dead-code gate). */
type RegimeStatus = 'ready' | 'migrating' | 'mixed-recovery';

export interface RegimeState {
  /** ready: objects uniformly in `regime`. migrating: an in-flight from→to pass. mixed-recovery: a forced full scan to heal stray outliers. */
  status: RegimeStatus;
  /** The regime objects are committed in NOW — what READY reads/writes key off. Advances to `to` only after a verified pass. */
  regime: R2SseRegime;
  from?: R2SseRegime;
  to?: R2SseRegime;
  /** Monotonic; ++ on every completed flip. Used as the verify-commit ordering marker (no container generation guard is built — the /start 409 gate + container drain cover that; see ADR AD91). */
  generation: number;
  /** ListObjectsV2 continuation-token for chunked resume; null/absent ⇒ start of pass. */
  cursor?: string | null;
  /** Consecutive verify-phase failures on the SAME object (`lastFailedKey`). Bounds the migrate↔verify retry on an un-migratable (poison/corrupt) object so it can never wedge into an infinite loop; resets when a different key fails (so a transient blip on another object can't trip the halt) and is dropped when the migration flips to ready. */
  stuckCount?: number;
  /** The object key that failed the last verify pass — `stuckCount` only accumulates while this stays the same (a persistent poison object), not for transient failures across different keys. */
  lastFailedKey?: string;
  /** SSE-C key fingerprint (key-MD5) captured at migration start — detects ENCRYPTION_KEY rotation (D3: detect-only). */
  keyMd5?: string;
  startedAt?: string;
  updatedAt?: string;
  /** Epoch ms. A `migrating` state past this is treated as crashed and taken over (replaces the old fixed TTL lock). */
  leaseExpiresAt?: number;
  /** Whether running containers have been drained for this migration (the copy loop drains once before its first chunk). */
  drained?: boolean;
  /** Two-stage pass: re-encrypt every object (`migrate`), then HEAD-scan every object under the target regime (`verify`) before flipping to ready. */
  phase?: 'migrate' | 'verify';
  lastError?: string;
}

type MigrationEnv = Pick<Env, 'KV'>;

/** A migration pass + verify for a real bucket finishes well within this; a crashed pass is retaken after it elapses. */
export const MIGRATION_LEASE_MS = 10 * 60 * 1000;

/** The default state for a bucket with no state object: legacy buckets are SSE-C and ready. */
function defaultState(regime: R2SseRegime = 'sse-c'): RegimeState {
  return { status: 'ready', regime, generation: 0 };
}

/**
 * Read the bucket's regime state. Absent ⇒ default ready/sse-c, EXCEPT we honor a
 * legacy `UserPreferences.r2SseRegime='plain'` marker (pre-state-object buckets that
 * were already migrated) so their objects are not misread as SSE-C.
 */
export async function getRegimeState(env: MigrationEnv, bucketName: string): Promise<RegimeState> {
  const state = await env.KV.get<RegimeState>(getRegimeStateKey(bucketName), 'json');
  if (state && state.status && state.regime) return state;
  // Legacy fallback: a bucket migrated under the old boolean marker before this state object existed.
  const prefs = await env.KV.get<UserPreferences>(getPreferencesKey(bucketName), 'json');
  return defaultState(prefs?.r2SseRegime === 'plain' ? 'plain' : 'sse-c');
}

/** Persist the bucket's regime state (stamps updatedAt). The dedicated key avoids the user-prefs read-modify-write clobber race. */
export async function setRegimeState(env: MigrationEnv, bucketName: string, state: RegimeState): Promise<void> {
  await env.KV.put(getRegimeStateKey(bucketName), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }));
}

/** Deployment-wide Governed Mode policy. `true` ⇒ SSE-C disabled (objects stored plain). Absent key ⇒ false (SSE-C on). */
export async function getR2SsePolicyDisabled(env: MigrationEnv): Promise<boolean> {
  return (await env.KV.get(SETUP_KEYS.R2_SSE_DISABLED)) === 'active';
}

/** Translate a policy boolean into the regime a bucket should be in. */
export function regimeForPolicy(policyDisabled: boolean): R2SseRegime {
  return policyDisabled ? 'plain' : 'sse-c';
}

/** The bucket's committed regime (what objects are actually in now). */
export async function getBucketR2Regime(env: MigrationEnv, bucketName: string): Promise<R2SseRegime> {
  return (await getRegimeState(env, bucketName)).regime;
}

/**
 * REQ-ENTERPRISE-018 backend gate: a bucket whose status is not `ready` (migrating or
 * mixed-recovery) blocks every writer with 409 so no client or stale container can write the
 * wrong encryption regime mid-migration. Throw BucketMigratingError at each writer entry.
 */
export async function isBucketMigrating(env: MigrationEnv, bucketName: string): Promise<boolean> {
  return (await getRegimeState(env, bucketName)).status !== 'ready';
}

/**
 * Whether SSE-C headers must be SUPPRESSED for this bucket's committed regime — the
 * value every storage write path threads into getSseHeaders/getSseCopyHeaders. While a
 * bucket is migrating, writes are gated (409) so this returns the committed `regime`.
 */
export async function isR2SseDisabledForBucket(env: MigrationEnv, bucketName: string): Promise<boolean> {
  return (await getBucketR2Regime(env, bucketName)) === 'plain';
}

/**
 * Resolve read headers for a bucket (D2): try the committed regime (`primary`) first, then
 * retry the opposite regime (`fallback`) once on an SSE-mismatch (400/403). A migrating bucket
 * holds objects in BOTH regimes, so the fallback keeps it readable. On a READY bucket the
 * primary almost always succeeds (no wasted fallback), but a fallback HIT means a stray
 * cross-regime outlier exists — `selfHealOnFallbackHit` tells the read path to kick off a
 * background mixed-recovery scan.
 */
export function resolveReadRegime(state: RegimeState): { primary: boolean; fallback: boolean; selfHealOnFallbackHit: boolean } {
  const primary = state.regime === 'plain';
  return { primary, fallback: !primary, selfHealOnFallbackHit: state.status === 'ready' };
}

/**
 * Resolve the r2SseDisabled flag a seed/write path uses right after ensuring a bucket
 * exists. A freshly created bucket has no objects, so it adopts the deployment policy and
 * its state is stamped ready in that regime; an existing bucket keeps its committed regime
 * (the login driver reconciles it to the policy later).
 */
export async function resolveBucketSseOnEnsure(env: MigrationEnv, bucketName: string, created: boolean): Promise<boolean> {
  if (created) {
    const policyDisabled = await getR2SsePolicyDisabled(env);
    await setRegimeState(env, bucketName, defaultState(regimeForPolicy(policyDisabled)));
    return policyDisabled;
  }
  return isR2SseDisabledForBucket(env, bucketName);
}
