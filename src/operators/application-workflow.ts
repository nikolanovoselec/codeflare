import { z } from 'zod';
import type { ApplicationStateBinding } from './application-state';
import type { VerifiedHumanAccessClaims } from '../lib/jwt';
import type { OperatorDelegation, OperatorExecutionContext } from './execution-context';
import type { ManagementAdmissionReceipt } from './registry';

/** The approved manifest selects the adapter, never a package ID or intent version. */
export function hasApplicationWorkflow(manifestJson: string): boolean {
  const manifest: unknown = JSON.parse(manifestJson);
  return !!manifest && typeof manifest === 'object' && 'application' in manifest
    && !!manifest.application && typeof manifest.application === 'object'
    && 'controlVersion' in manifest.application && manifest.application.controlVersion === 1;
}

const message = z.union([
  z.strictObject({ kind: z.literal('user'), body: z.string() }),
  z.strictObject({ kind: z.literal('signal'), type: z.string().min(1), body: z.string(),
    attributes: z.record(z.string(), z.string()).optional(), tagName: z.string().optional() }),
]);
const decision = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('dispatch'), checkpoint: z.json(), message, context: z.json() }),
  z.strictObject({ kind: z.literal('complete'), checkpoint: z.json(), result: z.json() }),
]);
export type ApplicationDecision = z.infer<typeof decision>;
export type ApplicationValue = z.infer<ReturnType<typeof z.json>>;
export type ApplicationSettlement = {
  receipt: { submissionId: string; uid: string; acceptedAt: string; deduplicated?: true };
} & ({ reply: { text: string; data: Record<string, ApplicationValue[]>;
  metadata?: Record<string, ApplicationValue>; uid: string; submissionId: string } }
  | { status: 'failed'; data: Record<string, ApplicationValue[]> });
export interface ApplicationWorkflow {
  version: 1;
  /** Original public input, configuration and runtime settings, not refreshed on continuation. */
  initialData: ApplicationValue;
  checkpoint: ApplicationValue;
  delivery: { token: string; ordinal: number };
  context: ApplicationValue;
  /** Prepared before invoking the planner, and committed with its exact opaque response. */
  idempotencyKey: string;
  planned: boolean;
}

export function parseApplicationDecision(value: unknown, byteLimit: number): ApplicationDecision {
  const parsed = decision.parse(value);
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes(parsed.checkpoint) > byteLimit
    || bytes(parsed) > byteLimit + 64 * 1024
    || (parsed.kind === 'complete' ? bytes(parsed.result) > byteLimit
      : bytes({ message: parsed.message, context: parsed.context }) > byteLimit)) {
    throw new Error('Application decision exceeds admitted capacity');
  }
  return parsed;
}

/** Internal RPC authority; constructed only after current Activity authorization.
 * Registry validates these pinned fields locally; it must never call back into Activity. */
export interface RuntimeApplicationStateBinding extends ApplicationStateBinding {
  principal: 'operator';
  human: VerifiedHumanAccessClaims;
  delegation?: OperatorDelegation;
  operatorId: string;
  sourceRepositoryId: number;
  releaseId: string;
  bundleDigest: string;
  installationRevision: number;
  operatorRevision: number;
  controlsRevision: number;
  intentDigest: string;
  deliveryToken: string;
}

/** Registry-only target authority. Original input/layout comes from the actual
 * immutable admission record/legacy codec, never the requesting application. */
export interface ApplicationExecutionAuthority {
  version: 1;
  current: RuntimeApplicationStateBinding;
  original: {
    activityId: string;
    installationId: string;
    operatorId: string;
    sourceRepositoryId: number;
    ownerKey: string;
    owner: OperatorExecutionContext['owner'];
    invocationJson?: string;
    /** Only the historical codec may select legacy binding/absent release pins. */
    binding: 'legacy' | 'activity';
    /** Private Root claim origin, selected from the stored envelope, never its JSON value. */
    delivery?: { submissionId: string; uid: string; deliveryDigest: string };
    generation?: number;
    pins: null | { operatorRevision: number; installationRevision: number; controlsRevision: number;
      releaseId: string; bundleDigest: string };
  };
  /** A successful null is proven absence. Errors/malformed records are not null. */
  ledger: { ok: true; receipt: ManagementAdmissionReceipt | null } | { ok: false };
  /** Trusted current observation policy only; cannot override the original admission policy. */
  observationLoggingEnabled?: boolean;
  proofVersion?: string;
}
export type ApplicationExecutionRequest = { operation: 'read' | 'read-delivery' | 'retire'; key: string; activityId: string; version: string };
export type ApplicationExecutionFacts = { status: 'unavailable' }
  | { status: 'delivery'; activityId: string; generation: number; releaseDigest: string; inputDigest: string;
    terminalAt: number; sdkSubmissionId: string; settled: true; fenced: true;
    noExternalWrites: boolean; outcome: 'completed' | 'failed' }
  | { status: 'never-started'; activityId: string; proofVersion: string; retired: boolean }
  | { status: 'value'; activityId: string; generation: number; releaseDigest: string; inputDigest: string;
    terminalAt: number; collected: true; settled: true; sdkSubmissionId: string; unknownEffects: false;
    /** Validated JSON, deliberately opaque across the native RPC boundary. */
    result: unknown; checkpoint: unknown };
export type ApplicationExecutionRetirement = { status: 'retired'; activityId: string; proofVersion: string }
  | { status: 'conflict' } | { status: 'unavailable' };

/** Structural equality for immutable runtime wires and read-only historical projections. */
export function sameApplicationValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => sameApplicationValue(value, right[index]));
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameApplicationValue(a[key], b[key]));
}
