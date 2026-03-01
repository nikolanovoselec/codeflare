import { Hono, type Context, type Next } from 'hono';
import { z } from 'zod';
import type { Env } from '../../types';
import { ValidationError, toError } from '../../lib/error-types';
import { resetSetupCache } from '../../lib/cache-reset';
import { listAllKvKeys, emailFromKvKey } from '../../lib/kv-keys';
import { cleanupUserData } from '../../lib/user-cleanup';
import { authMiddleware, requireAdmin, type AuthVariables } from '../../middleware/auth';
import { setupRateLimiter, logger, getWorkerNameFromHostname } from './shared';
import type { SetupStep } from './shared';
import { handleGetAccount } from './account';
import { handleDeriveR2Credentials } from './credentials';
import { handleSetSecrets } from './secrets';
import { handleConfigureCustomDomain } from './custom-domain';
import { handleCreateAccessApp } from './access';
import { handleConfigureTurnstile } from './turnstile';
import handlers from './handlers';
import { isOnboardingLandingPageActive } from '../../lib/onboarding';

const ConfigureBodySchema = z.object({
  customDomain: z
    .string()
    .min(1, 'customDomain is required')
    .regex(/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/, 'customDomain must be a valid domain (e.g. claude.example.com)'),
  allowedUsers: z
    .array(z.string().email('Each allowedUsers entry must be a valid email'))
    .min(1, 'allowedUsers must not be empty'),
  adminUsers: z
    .array(z.string().email('Each adminUsers entry must be a valid email'))
    .min(1, 'At least one admin user is required'),
  allowedOrigins: z.array(
    z.string().min(1).regex(/^\.[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/,
      'Origin patterns must start with . and contain valid domain segments (e.g., .workers.dev)')
  ).optional(),
}).refine(
  (data) => data.adminUsers.every((admin) => data.allowedUsers.includes(admin)),
  { message: 'All adminUsers must also be in allowedUsers', path: ['adminUsers'] }
);

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

/**
 * Conditional auth middleware factory for setup routes (FIX-11).
 * - First-time setup (setup:complete not set): public access (bootstrap)
 * - After setup complete: require admin auth via CF Access
 */
function createConditionalSetupAuth() {
  return async (c: Context<{ Bindings: Env; Variables: AuthVariables }>, next: Next) => {
    const isComplete = await c.env.KV.get('setup:complete');
    if (isComplete === 'true') {
      return authMiddleware(c, async () => requireAdmin(c, next));
    }
    return next();
  };
}

// Apply conditional auth and rate limiting to setup routes
app.use('/detect-token', createConditionalSetupAuth());
app.use('/detect-token', setupRateLimiter);
app.use('/prefill', createConditionalSetupAuth());
app.use('/prefill', setupRateLimiter);

// Register simple endpoint handlers (status, detect-token, prefill)
app.route('/', handlers);

app.use('/configure', createConditionalSetupAuth());

/**
 * POST /api/setup/configure
 * Main setup endpoint - configures everything using extracted step handlers
 *
 * Body: { customDomain: string, allowedUsers: string[], adminUsers: string[], allowedOrigins?: string[] }
 * Token is read from env (CLOUDFLARE_API_TOKEN), not from request body.
 */
app.use('/configure', setupRateLimiter);
app.post('/configure', async (c) => {
  // Validate body synchronously before starting the stream
  const body = await c.req.json();
  const parsed = ConfigureBodySchema.safeParse(body);
  if (!parsed.success) {
    const firstError = parsed.error.issues[0];
    throw new ValidationError(firstError.message);
  }

  const { customDomain, allowedUsers, adminUsers, allowedOrigins } = parsed.data;
  const token = c.env.CLOUDFLARE_API_TOKEN;

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const send = (data: Record<string, unknown>) => {
    return writer.write(encoder.encode(JSON.stringify(data) + '\n'));
  };

  // Run setup steps in the background, streaming progress as NDJSON
  (async () => {
    const steps: SetupStep[] = [];
    const lockKey = 'setup:configuring';
    let lockAcquired = false;

    // Helper to run a named step with streaming progress
    const runStep = async <T>(stepName: string, fn: () => Promise<T>): Promise<T> => {
      await send({ step: stepName, status: 'running' });
      try {
        const result = await fn();
        await send({ step: stepName, status: 'success' });
        return result;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await send({ step: stepName, status: 'error', error: msg });
        throw error;
      }
    };

    try {
      // Acquire KV-based lock to prevent concurrent configure runs
      const existingLock = await c.env.KV.get(lockKey);
      if (existingLock) {
        const lockTime = parseInt(existingLock, 10);
        if (!isNaN(lockTime) && Date.now() - lockTime < 60_000) {
          await send({ done: true, success: false, error: 'Setup configuration is already in progress. Please wait and try again.' });
          return;
        }
        logger.warn('Overriding stale setup lock', { lockAge: Date.now() - lockTime });
      }
      await c.env.KV.put(lockKey, String(Date.now()), { expirationTtl: 300 });
      lockAcquired = true;

      // Step 1: Get account ID
      const accountId = await runStep('get_account', () => handleGetAccount(token, steps));
      const workerName = getWorkerNameFromHostname(c.req.url, c.env.CLOUDFLARE_WORKER_NAME);

      // Step 2: Derive R2 S3 credentials
      const { accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey } =
        await runStep('derive_r2_credentials', () => handleDeriveR2Credentials(token, steps));

      // Step 3: Set worker secrets
      await runStep('set_secrets', () =>
        handleSetSecrets(token, accountId, r2AccessKeyId, r2SecretAccessKey, c.req.url, steps, workerName)
      );

      // Remove stale users not in the new allowedUsers list (full cleanup)
      const allowedSet = new Set(allowedUsers);
      const existingUserKeys = await listAllKvKeys(c.env.KV, 'user:');
      const staleEmails = existingUserKeys
        .filter(key => !allowedSet.has(emailFromKvKey(key.name)))
        .map(key => emailFromKvKey(key.name));

      if (staleEmails.length > 0) {
        await runStep('cleanup_stale_users', async () => {
          for (const staleEmail of staleEmails) {
            logger.info('Removing stale user with full cleanup', { email: staleEmail });
            await cleanupUserData(staleEmail, c.env);
          }
        });
      }

      // Store users in KV with role
      const adminSet = new Set(adminUsers);
      const userWrites = allowedUsers.map(email => {
        const role = adminSet.has(email) ? 'admin' : 'user';
        return c.env.KV.put(
          `user:${email}`,
          JSON.stringify({ addedBy: 'setup', addedAt: new Date().toISOString(), role })
        );
      });
      await Promise.all(userWrites);

      // Step 4 & 5: Custom domain + CF Access
      await runStep('configure_custom_domain', () =>
        handleConfigureCustomDomain(token, accountId, customDomain, c.req.url, steps, workerName)
      );
      await runStep('create_access_app', () =>
        handleCreateAccessApp(token, accountId, customDomain, allowedUsers, adminUsers, steps, c.env.KV, workerName)
      );

      const onboardingLandingActive = isOnboardingLandingPageActive(c.env.ONBOARDING_LANDING_PAGE);
      if (onboardingLandingActive) {
        await runStep('configure_turnstile', () =>
          handleConfigureTurnstile(token, accountId, customDomain, steps, c.env.KV, workerName, c.req.url)
        );
      }
      await c.env.KV.put('setup:onboarding_landing_page', onboardingLandingActive ? 'active' : 'inactive');

      // Store custom domain in KV (case-insensitive per RFC 4343)
      await c.env.KV.put('setup:custom_domain', customDomain.toLowerCase());

      // Build combined allowed origins list
      const combinedOrigins = new Set<string>(allowedOrigins || []);
      combinedOrigins.add(`.${customDomain.toLowerCase()}`);
      combinedOrigins.add('.workers.dev');
      await c.env.KV.put('setup:allowed_origins', JSON.stringify([...combinedOrigins]));

      // Final step: Mark setup as complete
      await runStep('finalize', async () => {
        await c.env.KV.put('setup:account_id', accountId);
        await c.env.KV.put('setup:r2_endpoint', `https://${accountId}.r2.cloudflarestorage.com`);
        await c.env.KV.put('setup:completed_at', new Date().toISOString());
        await c.env.KV.put('setup:complete', 'true');
      });

      resetSetupCache();

      const url = new URL(c.req.url);
      const workersDevUrl = `https://${url.host}`;

      await send({
        done: true,
        success: true,
        steps,
        workersDevUrl,
        customDomainUrl: `https://${customDomain}`,
      });
    } catch (error) {
      logger.error('Configuration error', toError(error));
      const msg = error instanceof Error ? error.message : 'Configuration failed';
      await send({ done: true, success: false, steps, error: msg });
    } finally {
      // Release configure lock
      if (lockAcquired) {
        await c.env.KV.delete(lockKey).catch(() => {});
      }
      writer.close();
    }
  })();

  return new Response(readable, {
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
});

export default app;
