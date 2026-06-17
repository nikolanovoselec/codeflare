/**
 * Cloudflare Connect OAuth callback (mounted at /auth/cloudflare).
 *
 * Mirror of the GitHub connect callback (routes/github-auth.ts). Mints no session
 * cookie: identity is re-derived from the live session (same browser, cookies
 * present on the bounce-back) and the token is stored against that user's bucket.
 * State is HMAC-signed (CSRF) + single-use (nonce) + bound to the initiating
 * bucket, exactly like the GitHub connect flow.
 */
import { Hono } from 'hono';
import type { Env } from '../types';
import { createLogger } from '../lib/logger';
import { toError } from '../lib/error-types';
import { getBaseUrl } from '../lib/kv-keys';
import { verifyOauthState, parseOauthState, claimOauthNonce } from '../lib/oauth-state';
import { createRateLimiter } from '../middleware/rate-limit';
import { authenticateRequest } from '../lib/access';
import {
  connectCloudflare,
  getCloudflareProvider,
  connectStateSecret,
  CONNECT_CALLBACK_PATH,
} from '../lib/cloudflare-token';

const logger = createLogger('cloudflare-auth');

const app = new Hono<{ Bindings: Env }>();

/** Rate limit the callback to prevent token-endpoint exhaustion (10 req/min per IP). */
const callbackRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 10,
  keyPrefix: 'cloudflare-auth',
});

// GET /connect/callback — capture an account-scoped Cloudflare token.
app.get('/connect/callback', callbackRateLimiter, async (c) => {
  const base = await getBaseUrl(c.env.KV, c.req.url);
  const appUrl = `${base}/app/`;
  const url = new URL(c.req.url);

  if (url.searchParams.get('error')) {
    return c.redirect(`${appUrl}?cloudflare=denied`);
  }

  const secret = connectStateSecret(c.env);
  const provider = await getCloudflareProvider(c.env);
  if (!secret || !provider) {
    return c.redirect(`${appUrl}?cloudflare=unavailable`);
  }

  // Re-derive identity from the live session FIRST so the bucket is known before
  // the bucket-bound state can be verified (OAuth token-fixation CSRF defense).
  let bucketName: string;
  try {
    ({ bucketName } = await authenticateRequest(c.req.raw, c.env));
  } catch {
    return c.redirect(`${base}/?error=session-expired`);
  }

  const queryState = url.searchParams.get('state');
  if (!queryState || !(await verifyOauthState(queryState, secret, 1800, bucketName))) {
    return c.redirect(`${appUrl}?cloudflare=expired`);
  }
  const parsed = parseOauthState(queryState);
  if (!parsed || !(await claimOauthNonce(c.env.KV, parsed.nonce, 1800))) {
    return c.redirect(`${appUrl}?cloudflare=expired`);
  }

  const code = url.searchParams.get('code');
  if (!code) {
    return c.redirect(`${appUrl}?cloudflare=error`);
  }

  try {
    const { accountId } = await connectCloudflare(c.env, bucketName, code, `${base}${CONNECT_CALLBACK_PATH}`);
    // Single account auto-selected → connected; multiple → prompt for selection.
    return c.redirect(`${appUrl}?cloudflare=${accountId ? 'connected' : 'select-account'}`);
  } catch (err) {
    logger.error('Cloudflare connect failed', toError(err));
    return c.redirect(`${appUrl}?cloudflare=error`);
  }
});

export default app;
