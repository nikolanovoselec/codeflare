import { vi } from 'vitest';
import { withoutBillingState } from '../../lib/subscription';
import { createMockKV } from './mock-kv';

export function createMockBillingCoordinator(
  kv: ReturnType<typeof createMockKV>,
): DurableObjectNamespace {
  const coordinators = new Map<string, { fetch(request: Request): Promise<Response> }>();
  return {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn((id: string) => {
      const existingCoordinator = coordinators.get(id);
      if (existingCoordinator) return existingCoordinator;

      let token = 0;
      let lock = Promise.resolve();
      const coordinator = {
        fetch(request: Request): Promise<Response> {
          const path = new URL(request.url).pathname;
          if (path !== '/billing-sync/start' && path !== '/billing-sync/apply') {
            return Promise.resolve(new Response('Not found', { status: 404 }));
          }
          if (request.method !== 'POST') {
            return Promise.resolve(new Response('Method not allowed', { status: 405 }));
          }

          const run = lock.then(async () => {
            const body = await request.json() as {
              userEmail: string;
              token?: number;
              patch?: Record<string, unknown>;
            };
            if (path === '/billing-sync/start') {
              token += 1;
              return Response.json({ token });
            }
            if (body.token !== token) return Response.json({ applied: false });
            const existing = await kv.get(`user:${body.userEmail}`, 'json') as Record<string, unknown> | null;
            const patch = body.patch ?? {};
            const updated = patch.cleanupBillingState === true
              ? {
                  ...withoutBillingState(existing ?? {}),
                  billingStatus: patch.billingStatus,
                  subscriptionTier: patch.subscriptionTier,
                  accessTier: patch.accessTier,
                  subscribedMode: patch.subscribedMode,
                }
              : { ...existing, ...patch };
            await kv.put(`user:${body.userEmail}`, JSON.stringify(updated));
            return Response.json({
              applied: true,
              previous: {
                ...((existing?.subscribedMode) ? { subscribedMode: existing.subscribedMode } : {}),
                ...((existing?.subscriptionTier) ? { subscriptionTier: existing.subscriptionTier } : {}),
                ...((existing?.accessTier) ? { accessTier: existing.accessTier } : {}),
              },
            });
          });
          lock = run.then(() => undefined, () => undefined);
          return run;
        },
      };
      coordinators.set(id, coordinator);
      return coordinator;
    }),
  } as unknown as DurableObjectNamespace;
}
