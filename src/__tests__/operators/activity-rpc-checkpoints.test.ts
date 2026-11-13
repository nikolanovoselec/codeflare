/// <reference types="@cloudflare/vitest-plugin/types" />
import { Hash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { OperatorActivity } from '../../operators/activity';
import { activityRpcReceiverDigest, recordActivityRpcCheckpoint } from '../../operators/dispatcher-diagnostics-wire';
import { setLogLevel } from '../../lib/logger';

const stages = ['constructor-migration', 'agent-initialized', 'plan-entered', 'admission-read-completed'] as const;
const message = 'Prospective Renovate receiver checkpoint';
const privateContent = 'PRIVATE_RECEIVER_BODY owner@example.test Bearer private-token';
const namespace = (env as unknown as {
  OPERATOR_ACTIVITY: DurableObjectNamespace<OperatorActivity>;
}).OPERATOR_ACTIVITY;

function freshActivity() {
  const name = `receiver-private-${crypto.randomUUID()}`;
  return { name, stub: namespace.getByName(name) };
}

async function receiverDigest(id: DurableObjectId): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    JSON.stringify(['operator-activity-rpc-receiver:v1', id.toString()])));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

// Capture the intentional JSON console wire, not SDK calls or mock invocation counts.
async function captureWire(run: (wire: {
  output: string[];
  entries: Array<{ data: { checkpoint: string; receiverDigest: string } }>;
  breakSink: () => void;
}) => Promise<void>): Promise<void> {
  const output: string[] = [];
  const entries: Array<{ data: { checkpoint: string; receiverDigest: string } }> = [];
  let broken = false;
  const sinks = (['log', 'warn', 'error'] as const).map(sink => vi.spyOn(console, sink).mockImplementation((value: unknown) => {
    const text = String(value);
    output.push(text);
    let entry;
    try { entry = JSON.parse(text); } catch { return; }
    if (entry?.message !== message) return;
    entries.push(entry);
    // Other SDK/platform output is not part of this fault injection.
    if (broken) throw new Error(privateContent);
  }));
  setLogLevel('info');
  try { await run({ output, entries, breakSink: () => { broken = true; } }); }
  finally { setLogLevel('silent'); sinks.forEach(sink => sink.mockRestore()); }
}

function expectPrivate(output: string[], ...opaque: string[]) {
  const text = output.join('\n');
  for (const value of ['PRIVATE_RECEIVER_BODY', 'owner@example.test', 'private-token', ...opaque]) {
    expect(text).not.toContain(value);
  }
}

describe('REQ-OPERATOR-063 AC1/5/6: receiver checkpoints', () => {
  it('native ordinary plan RPC returns null and emits only four bounded hashed stages across repeat reads', async () => {
    const { name, stub } = freshActivity();
    const digest = await receiverDigest(stub.id);
    expect(activityRpcReceiverDigest(stub.id)).toBe(digest);
    await captureWire(async ({ entries, output }) => {
      // First operation on this fresh native named receiver is the real plan RPC.
      expect(await stub.getRuntimePlan()).toBeNull();
      const before = await runInDurableObject(stub, async (_instance, ctx) => {
        // An unadmitted retained body still returns null; it is never diagnostic payload.
        await ctx.storage.put('admission', { phase: 'prepared', invocationJson: privateContent });
        return [...await ctx.storage.list()];
      });
      expect(await stub.getRuntimePlan()).toBeNull();
      expect(await stub.getRuntimePlan()).toBeNull();
      const after = await runInDurableObject(stub, async (_instance, ctx) => [...await ctx.storage.list()]);
      expect(after).toEqual(before);
      // Exact shape is the approved public log contract, including absence of error/context fields.
      expect(entries).toEqual(stages.map(checkpoint => ({
        timestamp: expect.any(String), level: 'info', module: 'operator-activity', message,
        data: { checkpoint, receiverDigest: digest },
      })));
      for (const entry of entries) {
        expect(new TextEncoder().encode(JSON.stringify(entry.data)).byteLength).toBeLessThan(160);
      }
      expectPrivate(output, stub.id.toString(), name);
    });
  });

  it('instrumented native admission read exposes entry before settlement, not read completion or SDK lifecycle readiness', async () => {
    const { name, stub } = freshActivity();
    await captureWire(async ({ entries, output }) => {
      await runInDurableObject(stub, async (activity, ctx) => {
        let release!: () => void;
        let entered!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const reading = new Promise<void>(resolve => { entered = resolve; });
        const get = ctx.storage.get.bind(ctx.storage);
        const delayed = vi.spyOn(ctx.storage, 'get').mockImplementation((async (key: string) => {
          if (key === 'admission') { entered(); await held; }
          return get(key);
        }) as typeof ctx.storage.get);
        const plan = activity.getRuntimePlan();
        try {
          await reading;
          expect(entries.map(entry => entry.data.checkpoint)).toEqual(stages.slice(0, 3));
        } finally { release(); delayed.mockRestore(); }
        expect(await plan).toBeNull();
        expect(entries.map(entry => entry.data.checkpoint)).toEqual(stages);
      });
      expectPrivate(output, name, stub.id.toString());
    });
  });

  it.each(['null', 'storage-error'] as const)(
    'instrumented native plan preserves original %s with a throwing checkpoint sink and spends failed attempts', async outcome => {
      const { name, stub } = freshActivity();
      const original = new Error(privateContent);
      await captureWire(async ({ entries, output, breakSink }) => {
        await runInDurableObject(stub, async (activity, ctx) => {
          const before = [...await ctx.storage.list()];
          const get = ctx.storage.get.bind(ctx.storage);
          const fault = vi.spyOn(ctx.storage, 'get').mockImplementation((async (key: string) => {
            if (key === 'admission' && outcome === 'storage-error') throw original;
            return get(key);
          }) as typeof ctx.storage.get);
          breakSink();
          try {
            for (let read = 0; read < 3; read++) {
              if (outcome === 'storage-error') await expect(activity.getRuntimePlan()).rejects.toBe(original);
              else expect(await activity.getRuntimePlan()).toBeNull();
            }
            expect([...await ctx.storage.list()]).toEqual(before);
          } finally { fault.mockRestore(); }
          // Failed console delivery still consumes each stage; no retry flood.
          expect(entries.map(entry => entry.data.checkpoint)).toEqual(
            outcome === 'null' ? stages : stages.slice(0, 3));
        });
        expectPrivate(output, name, stub.id.toString());
      });
    });

  it.each(['hash', 'native-id'] as const)(
    'diagnostic %s fault spends both plan stages without changing the next native plan result', async faultKind => {
      const { name, stub } = freshActivity();
      await captureWire(async ({ entries, output }) => {
        await runInDurableObject(stub, async (activity, ctx) => {
          const before = [...await ctx.storage.list()];
          const originalId = Object.getOwnPropertyDescriptor(ctx, 'id');
          const update = Hash.prototype.update;
          const hashFault = faultKind === 'hash'
            ? vi.spyOn(Hash.prototype, 'update').mockImplementation(function(this: Hash, ...args: Parameters<Hash['update']>) {
              if (typeof args[0] === 'string' && args[0].startsWith('["operator-activity-rpc-receiver:v1",')) {
                throw new Error(privateContent);
              }
              return update.apply(this, args);
            })
            : undefined;
          if (faultKind === 'native-id') Object.defineProperty(ctx, 'id', {
            configurable: true, get() { throw new Error(privateContent); },
          });
          try {
            if (faultKind === 'native-id') {
              // Helper-only ID fault: do not poison the SDK's own native-context access.
              recordActivityRpcCheckpoint(ctx, 'plan-entered');
              recordActivityRpcCheckpoint(ctx, 'admission-read-completed');
            } else expect(await activity.getRuntimePlan()).toBeNull();
          } finally {
            hashFault?.mockRestore();
            if (faultKind === 'native-id') {
              if (originalId) Object.defineProperty(ctx, 'id', originalId);
              else Reflect.deleteProperty(ctx, 'id');
            }
          }
          expect(await activity.getRuntimePlan()).toBeNull();
          expect([...await ctx.storage.list()]).toEqual(before);
          // Both plan stages were attempted during the fault, so recovery cannot re-emit them.
          expect(entries.map(entry => entry.data.checkpoint)).toEqual(stages.slice(0, 2));
        });
        expectPrivate(output, name, stub.id.toString());
      });
    });

  it('pre-Agent migration fault retains original exception with a throwing sink and only migration-stage evidence', async () => {
    // Unit fault injection on a native Registry context, NOT a native Activity alarm/startup proof.
    // Migration throws before super: no fake Agent frame, lifecycle, or prototype replacement.
    const registry = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
    const name = `receiver-migration-private-${crypto.randomUUID()}`;
    const stub = registry.getByName(name);
    const original = new Error(privateContent);
    await captureWire(async ({ entries, output, breakSink }) => {
      await runInDurableObject(stub, async (_instance, ctx) => {
        const before = [...await ctx.storage.list()];
        const fault = vi.spyOn(ctx.storage.sql, 'exec').mockImplementation(() => { throw original; });
        breakSink();
        let caught: unknown;
        try {
          try { new OperatorActivity(ctx, env as ConstructorParameters<typeof OperatorActivity>[1]); }
          catch (error) { caught = error; }
          expect(caught).toBe(original);
        } finally { fault.mockRestore(); }
        expect([...await ctx.storage.list()]).toEqual(before);
        expect(entries.map(entry => entry.data.checkpoint)).toEqual(['constructor-migration']);
        expect(entries[0].data.receiverDigest).toBe(await receiverDigest(stub.id));
      });
      expectPrivate(output, name, stub.id.toString());
    });
  });
});
