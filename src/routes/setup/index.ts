import { Hono, type Context, type Next } from 'hono';
import { z } from 'zod';
import type { Env } from '../../types';
import { ValidationError, toError } from '../../lib/error-types';
import { parseJsonBody } from '../../lib/request-helpers';
import { resetSetupCache } from '../../lib/cache-reset';
import { listAllKvKeys, emailFromKvKey, getPreferencesKey, SETUP_KEYS } from '../../lib/kv-keys';
import { getBucketName } from '../../lib/access';
import { getOrImportKey, encryptAndStore } from '../../lib/kv-crypto';
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
import { isEnterpriseMode } from '../../lib/subscription';

// Feature A/C: a Cloudflare Access group name or a gateway route name. Trimmed,
// 1–256 chars, and MUST NOT contain comma or newline — those are the delimiters
// the runtime split() uses for the CSV-joined ENTERPRISE_ACCESS_GROUP value
// (src/lib/access.ts parseAccessGroups), and they would corrupt the catalog.
const accessNameSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z.string()
      .min(1, 'Name must not be empty')
      .max(256, 'Name must be at most 256 characters')
      .refine((s) => !/[,\n]/.test(s), 'Name must not contain a comma or newline'),
  );

const reasoningSchema = z.enum(['off', 'low', 'medium', 'high']);

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
  // Enterprise-only: customer-managed Cloudflare Access group NAMES that gate JIT
  // provisioning (REQ-ENTERPRISE-010). Sent as a validated chip list; persisted
  // comma-joined so access.ts parseAccessGroups keeps reading it. Absent for
  // non-enterprise setups.
  enterpriseAccessGroup: z.array(accessNameSchema).optional(),
  // REQ-ENTERPRISE-014 (enterprise-only): admin Access group NAMES whose members are
  // granted admin (= Setup access), parallel to the email-based adminUsers list.
  // Persisted comma-joined (parseAccessGroups reads it); excluded from per-group
  // routing by construction (only enterpriseAccessGroup keys may carry routing).
  adminAccessGroup: z.array(accessNameSchema).optional(),
  // Feature C (enterprise-only): the gateway dynamic-route catalog (route names)
  // plus an optional default route + reasoning level applied container-side.
  dynamicRoutes: z.array(accessNameSchema).optional(),
  defaultRoute: z
    .object({ route: accessNameSchema, reasoning: reasoningSchema })
    .nullable()
    .optional(),
  // REQ-BROWSER-007 (enterprise-only): the admin-global Cloudflare Browser Rendering
  // token + account id used by every enterprise session's browser-run. The token is
  // masked on prefill; a blank/masked value on save leaves the stored token in place.
  browserRenderToken: z.string().max(512).optional(),
  browserRenderAccountId: z.string().max(128).optional(),
  // REQ-GITHUB-008 (admin, any mode): admin-configured GitHub provider. The chooser
  // selects 'app' | 'oauth'; the matching client id is non-secret, the secret is
  // encrypted at rest and masked on prefill (blank on save ⇒ keep the stored secret).
  githubProviderType: z.enum(['app', 'oauth']).optional(),
  githubAppClientId: z.string().max(256).optional(),
  githubAppClientSecret: z.string().max(512).optional(),
  githubOauthClientId: z.string().max(256).optional(),
  githubOauthClientSecret: z.string().max(512).optional(),
  // Connect-to-Cloudflare OAuth client (admin, non-enterprise). The client id is
  // non-secret; the secret is encrypted at rest and masked on prefill (blank on
  // save ⇒ keep the stored secret). Mirrors the GitHub OAuth provider fields.
  cloudflareOauthClientId: z.string().max(256).optional(),
  cloudflareOauthClientSecret: z.string().max(512).optional(),
  // REQ-ENTERPRISE-013 (enterprise-only): per-group routing. Keyed by Access group
  // name -> { routes (subset of dynamicRoutes), defaultRoute (∈ that group's routes),
  // reasoning }. Absent ⇒ the global catalog applies to everyone (unchanged behavior).
  groupRouting: z
    .record(z.string(), z.object({
      routes: z.array(accessNameSchema),
      defaultRoute: accessNameSchema,
      reasoning: reasoningSchema,
    }))
    .optional(),
}).refine(
  (data) => data.adminUsers.every((admin) => data.allowedUsers.includes(admin)),
  { message: 'All adminUsers must also be in allowedUsers', path: ['adminUsers'] }
).refine(
  // A chosen default route must name a route that exists in the catalog.
  (data) =>
    !data.defaultRoute ||
    (data.dynamicRoutes ?? []).includes(data.defaultRoute.route),
  { message: 'defaultRoute.route must be one of dynamicRoutes', path: ['defaultRoute'] }
).refine(
  // REQ-ENTERPRISE-013: each group's defaultRoute must be one of that group's routes.
  (data) =>
    !data.groupRouting ||
    Object.values(data.groupRouting).every((g) => g.routes.includes(g.defaultRoute)),
  { message: "each group's defaultRoute must be one of that group's routes", path: ['groupRouting'] }
).refine(
  // REQ-ENTERPRISE-013: each group's routes must be a subset of the global catalog.
  (data) =>
    !data.groupRouting ||
    Object.values(data.groupRouting).every((g) => g.routes.every((r) => (data.dynamicRoutes ?? []).includes(r))),
  { message: "each group's routes must all be in dynamicRoutes", path: ['groupRouting'] }
).refine(
  // REQ-ENTERPRISE-013: routing may only be configured for configured Access groups.
  (data) =>
    !data.groupRouting ||
    Object.keys(data.groupRouting).every((name) => (data.enterpriseAccessGroup ?? []).includes(name)),
  { message: 'groupRouting keys must be configured Access groups', path: ['groupRouting'] }
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
  const body = await parseJsonBody(c, ConfigureBodySchema);

  const { customDomain, allowedUsers, adminUsers, allowedOrigins, enterpriseAccessGroup, adminAccessGroup, dynamicRoutes, defaultRoute, browserRenderToken, browserRenderAccountId, githubProviderType, githubAppClientId, githubAppClientSecret, githubOauthClientId, githubOauthClientSecret, cloudflareOauthClientId, cloudflareOauthClientSecret, groupRouting } = body;
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

  // Enterprise mode requires at least one dynamic route: every request must
  // resolve to a gateway route (the first route is the default). Validated here,
  // before any KV write, so a rejected configure leaves no partial state.
  if (isEnterpriseMode(c.env) && (dynamicRoutes ?? []).length === 0) {
    throw new ValidationError('At least one dynamic route is required in enterprise mode');
  }

  // REQ-GITHUB-008: a provider client secret stored without ENCRYPTION_KEY would be
  // plaintext at rest. Applies to the GitHub provider (admin, any mode) and the
  // Connect-to-Cloudflare OAuth client. Reject before any KV write (so a rejected
  // configure leaves no partial state) rather than silently downgrade — fail closed.
  if (githubAppClientSecret?.trim() || githubOauthClientSecret?.trim() || cloudflareOauthClientSecret?.trim()) {
    if (!(await getOrImportKey(c.env))) {
      throw new ValidationError('ENCRYPTION_KEY must be configured before storing a client secret');
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
          handleCreateAccessApp(token, accountId, customDomain, allowedUsers, adminUsers, steps, c.env.KV, workerName, isSaasModeActive(c.env.SAAS_MODE), isEnterpriseMode(c.env))
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

      // Enterprise: persist (or clear) the optional Access groups that gate JIT
      // provisioning. Persisted comma-joined (the format access.ts
      // parseAccessGroups splits on) so the runtime reader is unchanged. Schema
      // already trimmed each name and forbade comma/newline. Gated on
      // isEnterpriseMode so the write mirrors the read.
      if (isEnterpriseMode(c.env) && enterpriseAccessGroup !== undefined) {
        const joinedGroups = enterpriseAccessGroup.join(',');
        if (joinedGroups) {
          await c.env.KV.put(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP, joinedGroups);
        } else {
          await c.env.KV.delete(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP);
        }
      }

      // REQ-ENTERPRISE-014: persist (or clear) the optional admin Access groups,
      // same comma-joined format and enterprise gate as the user-access groups above.
      if (isEnterpriseMode(c.env) && adminAccessGroup !== undefined) {
        const joinedAdminGroups = adminAccessGroup.join(',');
        if (joinedAdminGroups) {
          await c.env.KV.put(SETUP_KEYS.ENTERPRISE_ADMIN_ACCESS_GROUP, joinedAdminGroups);
        } else {
          await c.env.KV.delete(SETUP_KEYS.ENTERPRISE_ADMIN_ACCESS_GROUP);
        }
      }

      // Feature C: persist the enterprise dynamic-route catalog and the default
      // route+reasoning. Stored as JSON (no legacy CSV reader, unlike groups).
      // Same enterprise gate; the catalog is non-empty here (validated above).
      if (isEnterpriseMode(c.env) && dynamicRoutes !== undefined) {
        await c.env.KV.put(SETUP_KEYS.DYNAMIC_ROUTES, JSON.stringify(dynamicRoutes));
      }
      if (isEnterpriseMode(c.env) && defaultRoute !== undefined) {
        if (defaultRoute) {
          await c.env.KV.put(SETUP_KEYS.DEFAULT_ROUTE, JSON.stringify(defaultRoute));
        } else {
          await c.env.KV.delete(SETUP_KEYS.DEFAULT_ROUTE);
        }
      }

      // REQ-BROWSER-007: persist the admin-global Cloudflare Browser Rendering token
      // (encrypted at rest) + its account id, used by every enterprise session's
      // browser-run. Both fields are no-clobber on blank: the wizard prefills the
      // account id and sends the token blank when unchanged (the stored token never
      // round-trips to the client), so a blank value means "keep what's stored", not
      // "clear" — keeping the token+account a coherent pair (removing a configured
      // token is not a v1 affordance). The account id is non-secret; the token is
      // encrypted. Enterprise-gated, mirroring the read in applyEnterpriseBrowserToken.
      if (isEnterpriseMode(c.env)) {
        const acct = browserRenderAccountId?.trim();
        if (acct) {
          await c.env.KV.put(SETUP_KEYS.BROWSER_RENDER_ACCOUNT_ID, acct);
        }
        const tok = browserRenderToken?.trim();
        if (tok) {
          const cryptoKey = await getOrImportKey(c.env);
          await encryptAndStore(c.env.KV, SETUP_KEYS.BROWSER_RENDER_TOKEN, { token: tok }, cryptoKey);
        }

        // REQ-ENTERPRISE-013: persist the per-group routing map (or clear it when empty).
        if (groupRouting !== undefined) {
          if (Object.keys(groupRouting).length > 0) {
            await c.env.KV.put(SETUP_KEYS.GROUP_ROUTING, JSON.stringify(groupRouting));
          } else {
            await c.env.KV.delete(SETUP_KEYS.GROUP_ROUTING);
          }
        }
      }

      // REQ-GITHUB-008: persist the admin provider config (any mode — the Setup
      // wizard is admin-gated everywhere). Provider type + client ids are non-secret
      // (plain); client secrets are encrypted at rest. Every secret is no-clobber on
      // blank — the masked prefill sends them blank when unchanged, so a blank value
      // means "keep what's stored", not "clear". Covers the GitHub provider AND the
      // Connect-to-Cloudflare OAuth client. The no-ENCRYPTION_KEY case was rejected
      // pre-stream (fail closed); the cryptoKey guard below is defensive so a secret
      // is never written as plaintext even if the key somehow resolves null.
      if (githubProviderType) {
        await c.env.KV.put(SETUP_KEYS.GITHUB_PROVIDER_TYPE, githubProviderType);
      }
      const ghAppId = githubAppClientId?.trim();
      if (ghAppId) await c.env.KV.put(SETUP_KEYS.GITHUB_APP_CLIENT_ID, ghAppId);
      const ghOauthId = githubOauthClientId?.trim();
      if (ghOauthId) await c.env.KV.put(SETUP_KEYS.GITHUB_OAUTH_CLIENT_ID, ghOauthId);
      const cfOauthId = cloudflareOauthClientId?.trim();
      if (cfOauthId) await c.env.KV.put(SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_ID, cfOauthId);
      const ghAppSecret = githubAppClientSecret?.trim();
      const ghOauthSecret = githubOauthClientSecret?.trim();
      const cfOauthSecret = cloudflareOauthClientSecret?.trim();
      if (ghAppSecret || ghOauthSecret || cfOauthSecret) {
        const cryptoKey = await getOrImportKey(c.env);
        if (cryptoKey) {
          if (ghAppSecret) await encryptAndStore(c.env.KV, SETUP_KEYS.GITHUB_APP_CLIENT_SECRET, { secret: ghAppSecret }, cryptoKey);
          if (ghOauthSecret) await encryptAndStore(c.env.KV, SETUP_KEYS.GITHUB_OAUTH_CLIENT_SECRET, { secret: ghOauthSecret }, cryptoKey);
          if (cfOauthSecret) await encryptAndStore(c.env.KV, SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_SECRET, { secret: cfOauthSecret }, cryptoKey);
        }
      }

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
