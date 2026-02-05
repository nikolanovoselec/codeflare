/**
 * Shared test app factory for backend route tests.
 *
 * Provides a consistent Hono app setup with mock env, auth variables,
 * and error handling. Individual test files register their own routes
 * via the `routes` option.
 *
 * Usage:
 *   const app = createTestApp({
 *     routes: [{ path: '/sessions', handler: crudRoutes }],
 *     mockKV,
 *   });
 */
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import type { AccessUser } from '../../types';
import { AppError } from '../../lib/error-types';

interface RouteRegistration {
  path: string;
  handler: Hono<any>;
}

interface TestAppOptions {
  /** Route handlers to register */
  routes: RouteRegistration[];
  /** Mock KV namespace (from createMockKV) */
  mockKV: unknown;
  /** Override env bindings */
  envOverrides?: Partial<Env>;
  /** Override auth user */
  user?: AccessUser;
  /** Override bucket name */
  bucketName?: string;
}

export function createTestApp(options: TestAppOptions) {
  const {
    routes,
    mockKV,
    envOverrides = {},
    user = { email: 'test@example.com', authenticated: true },
    bucketName = 'test-bucket',
  } = options;

  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

  // Shared error handler — AppError is the base class for all custom errors
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
    }
    return c.json({ error: err.message }, 500);
  });

  // Set up mock env and auth variables
  app.use('*', async (c, next) => {
    c.env = {
      KV: mockKV as unknown as KVNamespace,
      CONTAINER: {} as DurableObjectNamespace,
      ...envOverrides,
    } as unknown as Env;
    c.set('user', user);
    c.set('bucketName', bucketName);
    return next();
  });

  // Register routes
  for (const { path, handler } of routes) {
    app.route(path, handler);
  }

  return app;
}
