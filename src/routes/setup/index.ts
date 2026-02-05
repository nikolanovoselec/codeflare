import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../types';
import { ValidationError, SetupError, toError } from '../../lib/error-types';
import { resetSetupCache } from '../../lib/cache-reset';
import { listAllKvKeys, emailFromKvKey } from '../../lib/kv-keys';
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
    .regex(/^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/, 'customDomain must be a valid domain (e.g. claude.example.com)'),
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
 * Conditional auth middleware for /detect-token:
 * - First-time setup (setup:complete not set): public access (bootstrap)
 * - After setup complete: require admin auth via CF Access
 */
app.use('/detect-token', async (c, next) => {
  const isComplete = await c.env.KV.get('setup:complete');
  if (isComplete === 'true') {
    return authMiddleware(c, async () => requireAdmin(c, next));
  }
  return next();
});

/**
 * Conditional auth middleware for /prefill:
 * - First-time setup (setup:complete not set): public access (bootstrap)
 * - After setup complete: require admin auth via CF Access
 */
app.use('/prefill', async (c, next) => {
  const isComplete = await c.env.KV.get('setup:complete');
  if (isComplete === 'true') {
    return authMiddleware(c, async () => requireAdmin(c, next));
  }
  return next();
});

// Register simple endpoint handlers (status, detect-token, reset-for-tests, restore-for-tests)
app.route('/', handlers);

/**
 * Conditional auth middleware for /configure:
 * - First-time setup (setup:complete not set): public access (bootstrap)
 * - After setup complete: require admin auth via CF Access
 */
app.use('/configure', async (c, next) => {
  const isComplete = await c.env.KV.get('setup:complete');
  if (isComplete === 'true') {
    return authMiddleware(c, async () => requireAdmin(c, next));
  }
  return next();
});

/**
 * POST /api/setup/configure
 * Main setup endpoint - configures everything using extracted step handlers
 *
 * Body: { customDomain: string, allowedUsers: string[], allowedOrigins?: string[] }
 * Token is read from env (CLOUDFLARE_API_TOKEN), not from request body.
 */
app.use('/configure', setupRateLimiter);
app.post('/configure', async (c) => {
  const steps: SetupStep[] = [];
  const lockKey = 'setup:configuring';
  let lockAcquired = false;

  try {
    const body = await c.req.json();
    const parsed = ConfigureBodySchema.safeParse(body);
    if (!parsed.success) {
      const firstError = parsed.error.issues[0];
      throw new ValidationError(firstError.message);
    }

    const { customDomain, allowedUsers, adminUsers, allowedOrigins } = parsed.data;

    // Token from env (already set by GitHub Actions deploy)
    const token = c.env.CLOUDFLARE_API_TOKEN;

    // Acquire KV-based lock to prevent concurrent configure runs
    const existingLock = await c.env.KV.get(lockKey);
    if (existingLock) {
      // Override stale locks (>60s old)
      const lockTime = parseInt(existingLock, 10);
      if (!isNaN(lockTime) && Date.now() - lockTime < 60_000) {
        throw new ValidationError('Setup configuration is already in progress. Please wait and try again.');
      }
      logger.warn('Overriding stale setup lock', { lockAge: Date.now() - lockTime });
    }
    await c.env.KV.put(lockKey, String(Date.now()), { expirationTtl: 300 });
    lockAcquired = true;

    // Step 1: Get account ID
    const accountId = await handleGetAccount(token, steps);
    const workerName = getWorkerNameFromHostname(c.req.url, c.env.CLOUDFLARE_WORKER_NAME);

    // Step 2: Derive R2 S3 credentials from user's token
    const { accessKeyId: r2AccessKeyId, secretAccessKey: r2SecretAccessKey } =
      await handleDeriveR2Credentials(token, steps);

    // Step 3: Set worker secrets (R2 credentials — NOT CLOUDFLARE_API_TOKEN)
    await handleSetSecrets(
      token,
      accountId,
      r2AccessKeyId,
      r2SecretAccessKey,
      c.req.url,
      steps,
      workerName
    );

    // Remove stale users not in the new allowedUsers list
    const allowedSet = new Set(allowedUsers);
    const existingUserKeys = await listAllKvKeys(c.env.KV, 'user:');
    const staleDeletes = existingUserKeys
      .filter(key => !allowedSet.has(emailFromKvKey(key.name)))
      .map(key => {
        logger.info('Removed stale user', { email: emailFromKvKey(key.name) });
        return c.env.KV.delete(key.name);
      });
    await Promise.all(staleDeletes);

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
    await handleConfigureCustomDomain(token, accountId, customDomain, c.req.url, steps, workerName);
    await handleCreateAccessApp(
      token,
      accountId,
      customDomain,
      allowedUsers,
      adminUsers,
      steps,
      c.env.KV,
      workerName
    );

    const onboardingLandingActive = isOnboardingLandingPageActive(c.env.ONBOARDING_LANDING_PAGE);
    if (onboardingLandingActive) {
      await handleConfigureTurnstile(token, accountId, customDomain, steps, c.env.KV, workerName, c.req.url);
    }
    await c.env.KV.put('setup:onboarding_landing_page', onboardingLandingActive ? 'active' : 'inactive');

    // Store custom domain in KV
    // DNS names are case-insensitive (RFC 4343); normalize to lowercase so
    // Origin validation in cors-cache.ts never fails due to casing mismatch.
    await c.env.KV.put('setup:custom_domain', customDomain.toLowerCase());

    // Build combined allowed origins list:
    // 1. User-provided origins (if any)
    // 2. Auto-add the custom domain
    // 3. Always include .workers.dev as a default
    const combinedOrigins = new Set<string>(allowedOrigins || []);
    combinedOrigins.add(`.${customDomain.toLowerCase()}`);
    combinedOrigins.add('.workers.dev');
    await c.env.KV.put('setup:allowed_origins', JSON.stringify([...combinedOrigins]));

    // Final step: Mark setup as complete
    // Write setup:complete LAST so the system isn't considered configured if any prerequisite write fails
    steps.push({ step: 'finalize', status: 'pending' });
    await c.env.KV.put('setup:account_id', accountId);
    await c.env.KV.put('setup:r2_endpoint', `https://${accountId}.r2.cloudflarestorage.com`);
    await c.env.KV.put('setup:completed_at', new Date().toISOString());
    await c.env.KV.put('setup:complete', 'true');
    steps[steps.length - 1].status = 'success';

    // Reset in-memory caches so subsequent requests pick up new KV values
    resetSetupCache();

    // Release configure lock
    await c.env.KV.delete(lockKey);

    // Get the workers.dev URL from request
    const url = new URL(c.req.url);
    const workersDevUrl = `https://${url.host}`;

    return c.json({
      success: true,
      steps,
      workersDevUrl,
      customDomainUrl: `https://${customDomain}`,
    });

  } catch (error) {
    // Release configure lock on failure (only if we acquired it)
    if (lockAcquired) {
      await c.env.KV.delete(lockKey).catch(() => {});
    }

    if (error instanceof SetupError || error instanceof ValidationError) {
      throw error;
    }
    logger.error('Configuration error', toError(error));
    throw new SetupError('Configuration failed', steps);
  }
});

export default app;
