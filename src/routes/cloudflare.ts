/**
 * Cloudflare "Connect to Cloudflare" OAuth routes (mounted at /api/cloudflare).
 *
 * Connect/disconnect, connection status, and account selection. The token never
 * reaches the browser. UNLIKE the GitHub repo-browser panel, connect is NOT
 * gated on an advanced tier — it is reachable by any authenticated user via the
 * Guided Setup onboarding and the Settings "Push & Deploy" accordion, because it
 * is deploy-credential management (REQ-AGENT-018), not the repo browser.
 *
 * The matching OAuth callback lives in routes/cloudflare-auth.ts
 * (GET /auth/cloudflare/connect/callback) so Cloudflare redirects to a stable path.
 *
 * Non-enterprise only: getCloudflareProvider returns null in enterprise, so every
 * route fails closed there (503 GITHUB-style) — enterprise has no per-user CF deploy.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { authMiddleware, AuthVariables } from '../middleware/auth';
import { createRateLimiter } from '../middleware/rate-limit';
import { getBaseUrl } from '../lib/kv-keys';
import { signOauthState } from '../lib/oauth-state';
import { cloudflareScopeForTier } from '../lib/oauth-scopes';
import { parseJsonBody } from '../lib/request-helpers';
import {
  getCloudflareProvider,
  getCloudflareConnectionStatus,
  disconnectCloudflare,
  setCloudflareAccount,
  fetchCloudflareAccounts,
  getValidCloudflareToken,
  connectStateSecret,
  CONNECT_CALLBACK_PATH,
} from '../lib/cloudflare-token';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.use('*', authMiddleware);

const connectRateLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 20, keyPrefix: 'cloudflare-connect' });
const statusRateLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 60, keyPrefix: 'cloudflare-status' });

const AccountBody = z.object({ accountId: z.string().min(1).max(128) }).strict();

// GET /api/cloudflare/status — connection state (never the token). When connected
// without a selected account, surface the accessible accounts for the picker.
app.get('/status', statusRateLimiter, async (c) => {
  const provider = await getCloudflareProvider(c.env);
  const status = await getCloudflareConnectionStatus(c.env, c.get('bucketName'));
  let accounts: { id: string; name: string }[] | undefined;
  if (status.connected && !status.accountId) {
    const token = await getValidCloudflareToken(c.env, c.get('bucketName'));
    if (token) {
      try {
        accounts = await fetchCloudflareAccounts(token);
      } catch {
        /* leave accounts undefined; the picker simply won't populate */
      }
    }
  }
  return c.json({ configured: provider !== null, ...status, ...(accounts && { accounts }) });
});

// GET /api/cloudflare/connect — start the OAuth authorize flow (302 to Cloudflare).
// Browser-navigated, so it carries the session cookie through authMiddleware; the
// callback re-derives identity. Reachable for ANY authenticated user (not tier-gated).
app.get('/connect', connectRateLimiter, async (c) => {
  const provider = await getCloudflareProvider(c.env);
  if (!provider) {
    return c.json({ error: 'Cloudflare integration not configured', code: 'CLOUDFLARE_NOT_CONFIGURED' }, 503);
  }
  const secret = connectStateSecret(c.env);
  if (!secret) {
    return c.json({ error: 'Cloudflare integration not configured', code: 'CLOUDFLARE_NOT_CONFIGURED' }, 503);
  }

  const base = await getBaseUrl(c.env.KV, c.req.url);
  // Bind the state to the initiating user's bucket so the callback can only redeem
  // it against the same session (OAuth token-fixation CSRF defense, like GitHub).
  const state = await signOauthState(secret, c.get('bucketName'));
  const redirectUri = `${base}${CONNECT_CALLBACK_PATH}`;
  // Scope tier (minimal|recommended|advanced) from the connect URL; always includes
  // offline_access so a refresh token is issued.
  const scope = cloudflareScopeForTier(c.req.query('tier'));
  return c.redirect(provider.authorizeUrl({ state, redirectUri, scope }));
});

// POST /api/cloudflare/account — select the account for a connected token.
app.post('/account', connectRateLimiter, async (c) => {
  const { accountId } = await parseJsonBody(c, AccountBody);
  const ok = await setCloudflareAccount(c.env, c.get('bucketName'), accountId);
  if (!ok) {
    return c.json({ error: 'Account not accessible with the connected token', code: 'ACCOUNT_INVALID' }, 400);
  }
  return c.json({ success: true, accountId });
});

// POST /api/cloudflare/disconnect — revoke at Cloudflare + clear the token.
app.post('/disconnect', connectRateLimiter, async (c) => {
  await disconnectCloudflare(c.env, c.get('bucketName'));
  return c.json({ success: true });
});

export default app;
