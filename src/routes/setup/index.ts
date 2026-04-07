import { Hono, type Context, type Next } from 'hono';
import { z } from 'zod';
import type { Env } from '../../types';
import { ValidationError, toError } from '../../lib/error-types';
import { parseJsonBody, firstZodError } from '../../lib/request-helpers';
import { resetSetupCache } from '../../lib/cache-reset';
import { listAllKvKeys, emailFromKvKey, getPreferencesKey, SETUP_KEYS } from '../../lib/kv-keys';
import { getBucketName } from '../../lib/access';
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
import { isOnboardingLandingPageActive, isSaasModeActive } from '../../lib/onboarding';

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
    const isComplete = await c.env.KV.get(SETUP_KEYS.COMPLETE);
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
  const body = await parseJsonBody(c);
  const parsed = ConfigureBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(firstZodError(parsed.error));
  }

  const { customDomain, allowedUsers, adminUsers, allowedOrigins } = parsed.data;
  const token = c.env.CLOUDFLARE_API_TOKEN;

  // During reconfiguration, prevent admin from removing themselves
  const currentUser = c.get('user');
  if (currentUser?.email) {
    const normalizedCurrentEmail = currentUser.email.trim().toLowerCase();
    const normalizedAdminList = adminUsers.map(e => e.trim().toLowerCase());
    if (!normalizedAdminList.includes(normalizedCurrentEmail)) {
      throw new ValidationError('You cannot remove yourself from the admin list');
    }
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const send = (data: Record<string, unknown>) => {
    return writer.write(encoder.encode(JSON.stringify(data) + '\n'));
  };

  // Run setup steps in the background, streaming progress as NDJSON
  (async () => {
    const steps: SetupStep[] = [];
    const lockKey = SETUP_KEYS.CONFIGURING;
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
      // Acquire KV-based lock to prevent concurrent configure runs (60s timeout).
      // If lock exists and is not stale, another setup is in progress.
      const existingLock = await c.env.KV.get(lockKey);
      if (existingLock) {
        const lockTime = parseInt(existingLock, 10);
        if (!isNaN(lockTime) && Date.now() - lockTime < 60_000) {
          await send({ done: true, success: false, error: 'Setup configuration is already in progress. Please wait and try again.' });
          return;
        }
        logger.warn('Overriding stale setup lock', { lockAge: Date.now() - lockTime });
      }
      // Write lock with 5-minute expiry to ensure cleanup if request dies
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

      // Normalize and deduplicate emails before any KV operations
      const normalizedAllowed = [...new Set(allowedUsers.map(e => e.trim().toLowerCase()))];
      const normalizedAdmins = [...new Set(adminUsers.map(e => e.trim().toLowerCase()))];

      // Remove stale users not in the new allowedUsers list (full cleanup).
      // In SaaS mode, only clean up removed admins — JIT-provisioned regular
      // users are managed via User Management, not setup.
      {
        const allowedSet = new Set(normalizedAllowed);
        const existingUserKeys = await listAllKvKeys(c.env.KV, 'user:');
        const isSaasMode = isSaasModeActive(c.env.SAAS_MODE);

        const staleEmails: string[] = [];
        for (const key of existingUserKeys) {
          const email = emailFromKvKey(key.name);
          if (allowedSet.has(email)) continue;

          if (isSaasMode) {
            // In SaaS mode, only remove users who were admins (not JIT regular users)
            const userData = await c.env.KV.get(key.name, 'json') as { role?: string } | null;
            if (userData?.role === 'admin') {
              staleEmails.push(email);
            }
          } else {
            staleEmails.push(email);
          }
        }

        if (staleEmails.length > 0) {
          await runStep('cleanup_stale_users', async () => {
            for (const staleEmail of staleEmails) {
              logger.info('Removing stale user with full cleanup', { email: staleEmail });
              await cleanupUserData(staleEmail, c.env);
            }
          });
        }
      }

      // Store users in KV with role.
      // In SaaS mode, preserve existing fields for admin users
      // that may already exist from JIT provisioning.
      const adminSet = new Set(normalizedAdmins);
      const isSaas = isSaasModeActive(c.env.SAAS_MODE);
      const userWrites = normalizedAllowed.map(async (email) => {
        const role = adminSet.has(email) ? 'admin' : 'user';
        const base = { addedBy: 'setup', addedAt: new Date().toISOString(), role };
        if (isSaas) {
          // Merge with existing KV entry to preserve tiers and other fields
          const existing = await c.env.KV.get(`user:${email}`, 'json') as Record<string, unknown> | null;
          const merged = { ...existing, ...base, accessTier: 'unlimited', subscriptionTier: 'unlimited' };
          return c.env.KV.put(`user:${email}`, JSON.stringify(merged));
        }
        // In non-SaaS mode, explicitly set tier for admins
        const entry = role === 'admin'
          ? { ...base, accessTier: 'advanced', subscriptionTier: 'unlimited' }
          : base;
        return c.env.KV.put(`user:${email}`, JSON.stringify(entry));
      });
      await Promise.all(userWrites);

      // Auto-set advanced session mode for admin users so their first
      // session seeds advanced skills and agent rules.
      const adminPrefsWrites = normalizedAdmins.map(async (email) => {
        const bucketName = getBucketName(email, workerName);
        const prefsKey = getPreferencesKey(bucketName);
        const existingPrefs = await c.env.KV.get(prefsKey, 'json');
        if (!existingPrefs) {
          await c.env.KV.put(prefsKey, JSON.stringify({ sessionMode: 'advanced' }));
        }
      });
      await Promise.all(adminPrefsWrites);

      // Step 4 & 5: Custom domain + CF Access
      await runStep('configure_custom_domain', () =>
        handleConfigureCustomDomain(token, accountId, customDomain, c.req.url, steps, workerName)
      );
      // Issue #140: Skip CF Access provisioning when GitHub OIDC is configured.
      // In SaaS + OIDC mode, the Worker handles authentication directly via the
      // github-auth routes and the requireIdentity middleware. Creating a CF Access
      // application on the same domain causes CF Access to intercept all requests
      // before the Worker runs, breaking the OIDC login flow.
      const useGithubOidc = isSaasModeActive(c.env.SAAS_MODE) && c.env.OAUTH_CLIENT_ID;
      if (useGithubOidc) {
        // No-op runStep keeps SSE progress events flowing (running → success)
        // so the wizard UI advances naturally. No CF Access resources are created.
        await runStep('create_access_app', async () => { /* skipped: GitHub OIDC handles auth */ });
      } else {
        await runStep('create_access_app', () =>
          handleCreateAccessApp(token, accountId, customDomain, allowedUsers, adminUsers, steps, c.env.KV, workerName, isSaasModeActive(c.env.SAAS_MODE))
        );
      }

      const onboardingLandingActive = isOnboardingLandingPageActive(c.env.ONBOARDING_LANDING_PAGE);
      const saasMode = isSaasModeActive(c.env.SAAS_MODE);
      // Turnstile is needed for onboarding landing (waitlist) AND SaaS mode (access requests)
      if (onboardingLandingActive || saasMode) {
        await runStep('configure_turnstile', () =>
          handleConfigureTurnstile(token, accountId, customDomain, steps, c.env.KV, workerName, c.req.url)
        );
      }
      await c.env.KV.put(SETUP_KEYS.ONBOARDING_LANDING_PAGE, onboardingLandingActive ? 'active' : 'inactive');

      // Store custom domain in KV (case-insensitive per RFC 4343)
      await c.env.KV.put(SETUP_KEYS.CUSTOM_DOMAIN, customDomain.toLowerCase());

      // Build combined allowed origins list
      const combinedOrigins = new Set<string>(allowedOrigins || []);
      combinedOrigins.add(`.${customDomain.toLowerCase()}`);
      combinedOrigins.add('.workers.dev');
      await c.env.KV.put(SETUP_KEYS.ALLOWED_ORIGINS, JSON.stringify([...combinedOrigins]));

      // Final step: Mark setup as complete
      await runStep('finalize', async () => {
        await c.env.KV.put(SETUP_KEYS.ACCOUNT_ID, accountId);
        await c.env.KV.put(SETUP_KEYS.R2_ENDPOINT, `https://${accountId}.r2.cloudflarestorage.com`);
        await c.env.KV.put(SETUP_KEYS.COMPLETED_AT, new Date().toISOString());
        await c.env.KV.put(SETUP_KEYS.COMPLETE, 'true');
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
