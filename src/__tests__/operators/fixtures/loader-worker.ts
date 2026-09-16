import { WorkerEntrypoint } from 'cloudflare:workers';
import { loadOperatorWorker, type OperatorLoaderBinding } from '../../../operators/loader';
import type { OperatorBundle } from '../../../operators/distribution';

import { OperatorRegistry, type OperatorAdmissionRequest } from '../../../operators/registry';
import { OperatorActivity, type OperatorActivityPreparation } from '../../../operators/activity';
/** Native eviction fixture proves state survives a new DO instance, not isolate memory. */
export class FixtureActivity extends OperatorActivity {
  private readonly instanceId = crypto.randomUUID();
  getInstanceId(): string { return this.instanceId; }
  evictForTest(): void { this.ctx.abort('Operator checkpoint fixture eviction'); }
}

/** Simulates one lost RPC response after receipt commit, without changing registry logic. */
export class FixtureRegistry extends OperatorRegistry {
  override async admit(request: OperatorAdmissionRequest) {
    const result = await super.admit(request);
    const faultKey = `fixture:lost:${request.activityId}`;
    if (result.ok && request.operatorId.startsWith('lost-response-') && !await this.ctx.storage.get(faultKey)) {
      await this.ctx.storage.put(faultKey, true);
      throw new Error('Fixture lost admission response after commit');
    }
    return result;
  }
}

export type ActivityFixtureCommand =
  | { action: 'prepare'; intent: OperatorActivityPreparation }
  | { action: 'start'; capability: string }
  | { action: 'observe' }
  | { action: 'begin-drive' }
  | { action: 'commit-drive'; generation: number; update: unknown }
  | { action: 'cancel-drive' }
  | { action: 'interrupt-drive'; generation: number }
  | { action: 'instance' }
  | { action: 'evict' };

export type RegistryFixtureCommand =
  | { action: 'create'; operatorId: string }
  | { action: 'approve'; operatorId: string; artifactDigest: string; expectedRevision: number }
  | { action: 'enable'; operatorId: string; enabled: boolean; expectedRevision: number }
  | { action: 'admit'; request: OperatorAdmissionRequest }
  | { action: 'receipt'; activityId: string };

interface FixtureEnv {
  LOADER: OperatorLoaderBinding;
  PARENT_SECRET: string;
  REGISTRY: DurableObjectNamespace<OperatorRegistry>;
  ACTIVITY: DurableObjectNamespace<FixtureActivity>;
}

/** Test-only RPC capability. Identity comes from the parent binding, not arguments. */
export class FixtureCapability extends WorkerEntrypoint<FixtureEnv> {
  identity(_spoofedIdentity: string): string {
    return (this.ctx.props as { principal: string }).principal;
  }
}

/** Deterministic transport fixture: no provider, Internet, credentials or billing. */
export class FixtureOutbound extends WorkerEntrypoint<FixtureEnv> {
  fetch(request: Request): Response {
    if (new URL(request.url).hostname !== 'inference.example.test') {
      return new Response('denied', { status: 403 });
    }
    return Response.json({ principal: (this.ctx.props as { principal: string }).principal, intercepted: true });
  }
}

const bundle: OperatorBundle = {
  schemaVersion: 1, interfaceVersion: 1,
  compatibilityDate: '2026-02-05', compatibilityFlags: ['nodejs_compat'],
  mainModule: 'index.js',
  modules: { 'index.js': { js: `
    let counter = 0;
    export default {
      async fetch(request, env) {
        const path = new URL(request.url).pathname;
        if (path === '/identity') return Response.json({
          principal: await env.OPERATOR.identity('attacker'), bindings: Object.keys(env)
        });
        if (path === '/allowed') return fetch('https://inference.example.test/v1/responses');
        if (path === '/denied') return fetch('https://denied.example.test/');
        return Response.json({ counter: ++counter });
      }
    };
  ` } },
};

export default {
  async fetch(request: Request, env: FixtureEnv, ctx: ExecutionContext): Promise<Response> {
    const entrypoints = (ctx as unknown as { exports: Record<string,
      (options: { props: { principal: string } }) => Fetcher> }).exports;
    const props = { principal: 'fixture-owner' };
    try {
      const url = new URL(request.url);
      if (url.pathname === '/activity') {
        const activity = env.ACTIVITY.getByName(url.searchParams.get('activity') ?? 'default');
        const command = await request.json<ActivityFixtureCommand>();
        switch (command.action) {
          case 'prepare': return Response.json(await activity.prepare(command.intent));
          case 'start': return Response.json(await activity.start(command.capability));
          case 'observe': return Response.json(await activity.getAdmission());
          case 'begin-drive': return Response.json(await activity.beginDrive());
          case 'commit-drive': return Response.json(await activity.commitDrive(command.generation, command.update));
          case 'cancel-drive': return Response.json(await activity.cancelDrive());
          case 'interrupt-drive': return Response.json(await activity.interruptDrive(command.generation));
          case 'instance': return Response.json(await activity.getInstanceId());
          case 'evict':
            await activity.evictForTest().catch(() => {});
            return Response.json({ evicted: true });
        }
      }
      if (url.pathname === '/registry') {
        const registry = env.REGISTRY.getByName(url.searchParams.get('fixture') ?? 'default');
        const command = await request.json<RegistryFixtureCommand>();
        switch (command.action) {
          case 'create': return Response.json(await registry.create(command.operatorId));
          case 'approve': return Response.json(await registry.approve(command.operatorId, command.artifactDigest, command.expectedRevision));
          case 'enable': return Response.json(await registry.setEnabled(command.operatorId, command.enabled, command.expectedRevision));
          case 'admit': return Response.json(await registry.admit(command.request));
          case 'receipt': return Response.json(await registry.getReceipt(command.activityId));
        }
      }
      const create = () => loadOperatorWorker(env.LOADER, bundle,
        entrypoints.FixtureCapability({ props }), entrypoints.FixtureOutbound({ props }));
      if (new URL(request.url).pathname === '/fresh') {
        const first = await create().fetch(new Request('https://child.test/count'));
        const second = await create().fetch(new Request('https://child.test/count'));
        return Response.json([await first.json(), await second.json()]);
      }
      return await create().fetch(request);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'fixture failed' }, { status: 500 });
    }
  },
};
