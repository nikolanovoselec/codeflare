import { WorkerEntrypoint } from 'cloudflare:workers';
import { loadOperatorWorker, type OperatorLoaderBinding } from '../../../operators/loader';
import type { OperatorBundle } from '../../../operators/distribution';

import { OperatorRegistry, type OperatorAdmissionRequest } from '../../../operators/registry';
export { OperatorRegistry };

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
