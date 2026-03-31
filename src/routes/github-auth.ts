/**
 * GitHub OAuth routes for SaaS mode authentication.
 *
 * Replaces Cloudflare Access when SAAS_MODE=active and OAUTH_CLIENT_ID is set.
 * Mounts at /auth/github — login, callback, and logout.
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { signSessionJWT } from '../lib/session-jwt';
import { createLogger } from '../lib/logger';
import { toError } from '../lib/error-types';
import { parseUserRecord } from '../lib/user-record';
import { getCookieValue } from '../lib/access';
import { getBaseUrl } from '../lib/kv-keys';
import { isActiveTier } from '../lib/subscription';
import { createRateLimiter } from '../middleware/rate-limit';

const logger = createLogger('github-auth');

const app = new Hono<{ Bindings: Env }>();

/** Rate limit callback to prevent GitHub API exhaustion (10 req/min per IP) */
const callbackRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 10,
  keyPrefix: 'github-auth',
});

// ---------------------------------------------------------------------------
// GET /login — Redirect to GitHub OAuth authorize
// ---------------------------------------------------------------------------
app.get('/login', async (c) => {
  const clientId = c.env.OAUTH_CLIENT_ID;
  if (!clientId || !c.env.OAUTH_CLIENT_SECRET || !c.env.OAUTH_JWT_SECRET) {
    logger.error('GitHub OAuth not configured — missing secrets');
    return c.json({ error: 'OAuth not configured' }, 500);
  }

  const state = crypto.randomUUID();
  const origin = await getBaseUrl(c.env.KV, c.req.url);
  const redirectUri = `${origin}/auth/github/callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'user:email',
    state,
  });

  c.header('Set-Cookie', `oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=300`);
  return c.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

// ---------------------------------------------------------------------------
// GET /callback — Exchange code for token, issue session JWT
// ---------------------------------------------------------------------------
app.get('/callback', callbackRateLimiter, async (c) => {
  if (!c.env.OAUTH_CLIENT_ID || !c.env.OAUTH_CLIENT_SECRET || !c.env.OAUTH_JWT_SECRET) {
    logger.error('GitHub OAuth not configured — missing secrets');
    return c.json({ error: 'OAuth not configured' }, 500);
  }

  const url = new URL(c.req.url);

  // Read base URL once for all redirects in this handler
  const base = await getBaseUrl(c.env.KV, c.req.url);

  // GitHub returns ?error= when user denies or something goes wrong.
  // Allow-list known error codes to prevent reflected content in the redirect URL.
  const KNOWN_ERRORS = new Set(['access_denied', 'redirect_uri_mismatch', 'application_suspended']);
  const errorParam = url.searchParams.get('error');
  if (errorParam) {
    const safeError = KNOWN_ERRORS.has(errorParam) ? errorParam : 'oauth_error';
    return c.redirect(`${base}/?error=${encodeURIComponent(safeError)}`);
  }

  // Validate state — cookie vs query param (CSRF protection)
  const queryState = url.searchParams.get('state');
  const cookieState = getCookieValue(c.req.header('Cookie') ?? null, 'oauth_state');
  if (!cookieState || !queryState || cookieState !== queryState) {
    return c.json({ error: 'Invalid OAuth state' }, 403);
  }

  // Clear state cookie
  c.header('Set-Cookie', `oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);

  const code = url.searchParams.get('code');
  if (!code) {
    return c.json({ error: 'Missing authorization code' }, 400);
  }

  // Exchange code for access token
  let accessToken: string;
  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: c.env.OAUTH_CLIENT_ID,
        client_secret: c.env.OAUTH_CLIENT_SECRET,
        code,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
    const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
    if (!tokenData.access_token) throw new Error(tokenData.error || 'No access token');
    accessToken = tokenData.access_token;
  } catch (err) {
    logger.error('GitHub token exchange failed', toError(err));
    return c.json({ error: 'GitHub authentication failed' }, 502);
  }

  // Fetch user profile + emails
  let userId: number;
  let userLogin: string;
  let email: string | null = null;
  try {
    const headers = { 'Authorization': `Bearer ${accessToken}`, 'User-Agent': 'Codeflare' };

    const [userRes, emailsRes] = await Promise.all([
      fetch('https://api.github.com/user', { headers, signal: AbortSignal.timeout(10_000) }),
      fetch('https://api.github.com/user/emails', { headers, signal: AbortSignal.timeout(10_000) }),
    ]);

    if (!userRes.ok) throw new Error(`GitHub user API: ${userRes.status}`);
    if (!emailsRes.ok) throw new Error(`GitHub emails API: ${emailsRes.status}`);

    const userData = await userRes.json() as { id: number; login: string };
    userId = userData.id;
    userLogin = userData.login;

    const emails = await emailsRes.json() as Array<{ email: string; primary: boolean; verified: boolean }>;
    const primary = emails.find(e => e.primary && e.verified);
    email = primary?.email ?? null;
  } catch (err) {
    logger.error('GitHub API failed', toError(err));
    return c.json({ error: 'Failed to fetch GitHub profile' }, 502);
  }

  // Reject if no verified email
  if (!email) {
    return c.redirect(`${base}/?error=no-verified-email`);
  }

  // Sign session JWT
  const jwt = await signSessionJWT(
    { email: email.toLowerCase().trim(), sub: String(userId), ghLogin: userLogin },
    c.env.OAUTH_JWT_SECRET,
  );

  // Determine redirect based on user state
  const userRecord = parseUserRecord(await c.env.KV.get(`user:${email.toLowerCase().trim()}`, 'json'));
  const isActive = userRecord ? isActiveTier(userRecord.subscriptionTier) : false;
  const redirectTo = isActive ? `${base}/app/` : `${base}/app/subscribe`;

  c.header('Set-Cookie', `codeflare_session=${jwt}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600`);
  logger.info('GitHub OAuth login successful', { email, ghLogin: userLogin });
  return c.redirect(redirectTo);
});

// ---------------------------------------------------------------------------
// GET /logout — Clear session cookie
// ---------------------------------------------------------------------------
app.get('/logout', async (c) => {
  c.header('Set-Cookie', `codeflare_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  const base = await getBaseUrl(c.env.KV, c.req.url);
  return c.redirect(`${base}/`);
});

export default app;
