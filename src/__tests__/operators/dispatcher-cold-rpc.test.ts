/// <reference types="@cloudflare/vitest-plugin/types" />
import { createHash } from 'node:crypto';
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { OperatorActivity } from '../../operators/activity';
import type { OperatorRegistry } from '../../operators/registry';

// CI-only diagnostic, not a Dispatcher workload or production/manual-prepare proof.
// The existing pool loads src/index.ts via wrangler.toml: the real exported
// OperatorActivity, locked agents 0.33.0, SQLite, 2026-02-05 + nodejs_compat.
// Do not import the instrumented dispatcher-production or Flue root fixtures.
const deadline = Symbol('probe-deadline');
async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(deadline), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

// Native RPC errors may expose accessor-backed fields. Read only these three
// under catch, never stringify the exception, and never emit raw message/stack.
function errorField(error: unknown, key: 'name' | 'message' | 'stack'): string | null {
  try {
    if (typeof error !== 'object' || error === null) return null;
    const value: unknown = Reflect.get(error, key);
    return typeof value === 'string' ? value : null;
  } catch { return null; }
}
function caughtError(error: unknown) {
  const message = errorField(error, 'message');
  const stack = errorField(error, 'stack');
  const name = errorField(error, 'name');
  // Only allowlisted source paths and numeric coordinates escape the stack.
  const allowedOriginFrames = [...(stack?.slice(0, 16384).matchAll(
    /(?:src\/operators\/activity\.ts|node_modules\/agents\/(?:src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ts|dist\/[A-Za-z0-9_-]+\.js)|node_modules\/\.vite\/deps\/agents(?:_lifecycle)?\.js):\d+:\d+/g,
  ) ?? [])].slice(0, 8).map(match => match[0]);
  return {
    classification: error === deadline ? 'probe-deadline'
      : message?.includes('could not determine its Durable Object name') ? 'sdk-name-unavailable'
      : name === 'TypeError' ? 'TypeError' : name === 'RangeError' ? 'RangeError'
      : name === 'Error' ? 'Error' : 'unclassified',
    messageDigest: message === null ? null : createHash('sha256')
      .update(Buffer.from(message.slice(0, 8192), 'utf8').subarray(0, 8192)).digest('hex'),
    messageTruncated: message !== null && (message.length > 8192 || Buffer.byteLength(message, 'utf8') > 8192),
    messageAvailable: message !== null,
    stackAvailable: stack !== null,
    allowedOriginFrames,
  };
}

type Stub = DurableObjectStub<OperatorActivity>;
async function metadata(stub: Stub, requestedName: string) {
  try {
    return await bounded(runInDurableObject(stub, async (_instance, ctx) => ({
      nativeNameAvailable: typeof ctx.id.name === 'string',
      nativeNameMatchesRequested: ctx.id.name === requestedName,
      legacyNamePresent: await ctx.storage.get('__ps_name') !== undefined,
      admissionPresent: await ctx.storage.get('admission') !== undefined,
    })), 2000);
  } catch (error) { return { unavailable: true, caughtError: caughtError(error) }; }
}

async function probe(stub: Stub, milliseconds: number) {
  try {
    // The ONLY business call: real namespace stub RPC, never a receiver-instance
    // call inside runInDurableObject. The parent control changes only the caller.
    // Agent's public async-method wrapper must pass lifecycle.start() first.
    const admission = await bounded(stub.getAdmission(), milliseconds);
    return { outcome: admission === null ? 'returned-null' : 'returned-non-null', caughtError: null };
  } catch (error) { return { outcome: 'rejected', caughtError: caughtError(error) }; }
}

it('CI diagnostic: fresh named exported OperatorActivity cold native RPC returns null through the SDK startup gate', async () => {
  const namespace = (env as unknown as {
    OPERATOR_ACTIVITY: DurableObjectNamespace<OperatorActivity>;
  }).OPERATOR_ACTIVITY;
  const freshName = `cold-rpc-${crypto.randomUUID()}`;
  const fresh = namespace.getByName(freshName);
  // No fetch, metadata visit, storage seed, construction, or other call first.
  const freshResult = await probe(fresh, 15_000);
  console.info('cold-rpc-probe', JSON.stringify({ schema: 'cold-rpc-ci.v1', case: 'fresh-named',
    ...freshResult, metadataAfterRpc: await metadata(fresh, freshName) }));

  // Explicit migration CONTROL only. Seeding this separate object's legacy name
  // does not make it a pristine cold object, and is never a product workaround.
  // No method, lifecycle.start(), or synthetic class is invoked in the callback.
  const legacyName = `cold-rpc-legacy-${crypto.randomUUID()}`;
  const legacy = namespace.getByName(legacyName);
  let legacyResult;
  try {
    await bounded(runInDurableObject(legacy, async (_instance, ctx) => {
      await ctx.storage.put('__ps_name', legacyName);
    }), 2000);
    legacyResult = await probe(legacy, 15_000);
  } catch (error) {
    legacyResult = { outcome: 'seed-rejected', caughtError: caughtError(error) };
  }
  console.info('cold-rpc-probe', JSON.stringify({ schema: 'cold-rpc-ci.v1', case: 'legacy-name-control',
    ...legacyResult, metadataAfterRpc: await metadata(legacy, legacyName) }));

  // Caller-context control, NOT an alarm or full cron reproduction. The real
  // Registry is only the caller; the fresh child's read has no Registry callback.
  const childName = `cold-rpc-parent-child-${crypto.randomUUID()}`;
  let parentResult;
  try {
    const registry = (env as unknown as {
      OPERATOR_REGISTRY: DurableObjectNamespace<OperatorRegistry>;
    }).OPERATOR_REGISTRY.getByName(`cold-rpc-parent-${crypto.randomUUID()}`);
    parentResult = await bounded(runInDurableObject(registry, async (_instance, _ctx) => {
      // Resolve the binding AND create the child stub inside the parent context.
      const childNamespace = (env as unknown as {
        OPERATOR_ACTIVITY: DurableObjectNamespace<OperatorActivity>;
      }).OPERATOR_ACTIVITY;
      return probe(childNamespace.getByName(childName), 15_000);
    }), 18_000);
  } catch (error) {
    parentResult = { outcome: 'parent-context-rejected', caughtError: caughtError(error) };
  }
  console.info('cold-rpc-probe', JSON.stringify({ schema: 'cold-rpc-ci.v1', case: 'parent-do-context',
    ...parentResult, metadataAfterRpc: await metadata(namespace.getByName(childName), childName) }));

  // Emit ALL THREE records before asserting. A native rejection is a real CI
  // failure; only a returned null establishes entry for each caller in this harness.
  expect([freshResult.outcome, legacyResult.outcome, parentResult.outcome])
    .toEqual(['returned-null', 'returned-null', 'returned-null']);
}, 60_000);
