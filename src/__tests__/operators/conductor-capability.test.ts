import { describe, expect, it, vi } from 'vitest';
import { OperatorConductorCapability, type ConductorCapabilityOperations } from '../../operators/conductor-capability';

function operations(): ConductorCapabilityOperations {
  return {
    current: vi.fn(async () => undefined),
    session: { ensure: vi.fn(async () => ({ status: 'ready' })), stop: vi.fn(async () => ({ status: 'stopped' })) },
    attachments: { restore: vi.fn(async input => ({ status: 'restored' as const, path: `input/${input.locator}.bin` })) },
    pi: {
      ensure: vi.fn(async () => ({ ready: true as const, conversationId: 'conversation-1' })),
      task: vi.fn(async input => ({ taskId: input.taskId, status: 'completed' })),
    },
    sync: { seal: vi.fn(async () => ({ status: 'sealed' as const, manifestDigest: 'a'.repeat(64),
      prefix: 'private/', filePrefix: 'output/' })) },
    storage: { read: vi.fn(async () => new TextEncoder().encode('opaque')) },
  };
}

async function post(capability: OperatorConductorCapability, path: string, body: unknown) {
  return capability.fetch(`https://operator.internal${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('generic installed Conductor capability', () => {
  it('exposes only generation-bound generic session, attachment, Pi, sync and bounded storage operations', async () => {
    const owner = operations();
    const capability = new OperatorConductorCapability(owner);
    expect(await (await post(capability, '/v1/session/ensure', { schemaVersion: 1 })).json()).toEqual({ status: 'ready' });
    expect(await (await post(capability, '/v1/storage/restore', { schemaVersion: 1,
      attachment: { locator: 'input-1', sha256: 'b'.repeat(64), size: 128 } })).json()).toEqual({
      status: 'restored', path: 'input/input-1.bin',
    });
    expect(await (await post(capability, '/v1/pi/tasks', { schemaVersion: 1, taskId: 'task-1', digest: 'c'.repeat(64),
      mode: 'prompt', text: 'Execute the package-owned procedure.' })).json()).toEqual({ taskId: 'task-1', status: 'completed' });
    expect(await (await post(capability, '/v1/storage/read', { schemaVersion: 1,
      key: 'private/output.bin', maxBytes: 64 })).json()).toEqual({ bytes: 'b3BhcXVl' });
    expect((await post(capability, '/v1/review', { schemaVersion: 1 })).status).toBe(404);
    expect(owner.current).toHaveBeenCalled();
  });

  it('fails closed before effects when authority is stale or a package selects an invalid scope', async () => {
    const owner = operations();
    owner.current = vi.fn(async () => { throw new Error('stale'); });
    const capability = new OperatorConductorCapability(owner);
    expect((await post(capability, '/v1/session/ensure', { schemaVersion: 1 })).status).toBe(403);
    expect(owner.session.ensure).not.toHaveBeenCalled();

    const current = operations();
    const scoped = new OperatorConductorCapability(current);
    expect((await post(scoped, '/v1/storage/read', { schemaVersion: 1,
      key: '../foreign', maxBytes: 64 })).status).toBe(403);
    expect(current.storage.read).not.toHaveBeenCalled();
  });
});
