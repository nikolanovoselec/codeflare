import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { Env } from '../../types';
import { createRateLimiter } from '../../middleware/rate-limit';
import { AppError, ValidationError } from '../../lib/error-types';
import { getAllUsers } from '../../lib/access-policy';
import { isOnboardingLandingPageActive, isSaasModeActive } from '../../lib/onboarding';
import { getTierConfig, SUBSCRIBABLE_TIER_IDS } from '../../lib/subscription';
import { escapeXml } from '../../lib/xml-utils';
import { createLogger } from '../../lib/logger';
import { parseJsonBody } from '../../lib/request-helpers';
import { verifyTurnstileToken } from '../../lib/turnstile';
import { CONTACT_TOPICS } from '../../lib/contact-topics';
import { SETUP_KEYS } from '../../lib/kv-keys';

const logger = createLogger('public-routes');

const WaitlistRequestSchema = z.object({
  email: z.string().email('Valid email is required'),
  turnstileToken: z.string().min(1, 'Turnstile token is required'),
});

// REQ-LANDING-002: enterprise demo-request submission from the landing page.
// Topics come from the shared constant (src/lib/contact-topics.ts) that the
// landing form renders, so the form can never offer a topic the API rejects.
const ContactRequestSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  email: z.string().email('Valid email is required').max(254),
  company: z.string().max(200).optional(),
  topic: z.enum(CONTACT_TOPICS),
  message: z.string().min(10, 'Message must be at least 10 characters').max(4000),
  turnstileToken: z.string().min(1, 'Turnstile token is required'),
});

const app = new Hono<{ Bindings: Env }>();

const waitlistRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 5,
  keyPrefix: 'waitlist-submit',
  // Defense-in-depth on an unauthenticated surface: if the rate-limit KV binding
  // is absent, reject rather than wave traffic through.
  failClosed: true,
});

const contactRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 5,
  keyPrefix: 'contact-submit',
  // Contact triggers an outbound email relay (Resend) — fail closed if the
  // rate-limit KV binding is absent so a misconfig can't enable an email flood.
  failClosed: true,
});

/**
 * Public-surface gate. The /public namespace exists for the unauthenticated
 * landing surface, which is served in onboarding mode AND SaaS mode
 * (REQ-LANDING-001) — everything 404s in default/enterprise mode where no
 * public landing exists. Waitlist routes carry an additional onboarding-only
 * gate below: the waitlist is an onboarding-mode concept.
 */
app.use('*', async (c, next) => {
  const publicSurfaceActive =
    isOnboardingLandingPageActive(c.env.ONBOARDING_LANDING_PAGE) || isSaasModeActive(c.env.SAAS_MODE);
  if (!publicSurfaceActive) {
    return c.json({ error: 'Not found' }, 404);
  }
  return next();
});

/** Restricts waitlist-era routes to onboarding mode (their original gate). */
const requireOnboardingMode: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (!isOnboardingLandingPageActive(c.env.ONBOARDING_LANDING_PAGE)) {
    return c.json({ error: 'Not found' }, 404);
  }
  return next();
};

/**
 * Resend transport shared by the waitlist and contact notifications. Only
 * the message envelope differs per route; the HTTP contract lives here once.
 */
async function sendNotificationEmail(params: {
  resendApiKey: string;
  from: string;
  to: string[];
  subject: string;
  html: string;
  replyTo: string;
  errorCode: string;
}): Promise<void> {
  const { resendApiKey, from, to, subject, html, replyTo, errorCode } = params;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${resendApiKey}`,
    },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ from, to, subject, html, reply_to: replyTo }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new AppError(errorCode, 502, `Resend request failed: ${response.status} ${text}`);
  }
}

/**
 * Shared preconditions for Turnstile-protected public submissions: secrets
 * present, at least one admin recipient, and a passing CAPTCHA verification.
 * Returns what the email step needs.
 */
async function requireVerifiedSubmission(params: {
  env: Env;
  turnstileToken: string;
  remoteIp: string | null;
  unavailableCode: string;
  noRecipientCode: string;
  logContext: Record<string, string>;
}): Promise<{ resendApiKey: string; adminRecipients: string[] }> {
  const { env, turnstileToken, remoteIp, unavailableCode, noRecipientCode, logContext } = params;

  const turnstileSecret = env.TURNSTILE_SECRET_KEY || (await env.KV.get(SETUP_KEYS.TURNSTILE_SECRET_KEY));
  const resendApiKey = env.RESEND_API_KEY;

  if (!turnstileSecret || !resendApiKey) {
    throw new AppError(unavailableCode, 503, 'Public submission is not fully configured', 'Temporarily unavailable');
  }

  const users = await getAllUsers(env.KV);
  const adminRecipients = users.filter((u) => u.role === 'admin').map((u) => u.email);
  if (adminRecipients.length === 0) {
    throw new AppError(noRecipientCode, 503, 'No admin recipients configured', 'Temporarily unavailable');
  }

  const verification = await verifyTurnstileToken(turnstileToken, turnstileSecret, remoteIp);
  if (!verification.success) {
    logger.warn('Turnstile verification failed', {
      ...logContext,
      errorCodes: verification['error-codes'],
    });
    throw new ValidationError('CAPTCHA verification failed');
  }

  return { resendApiKey, adminRecipients };
}

app.get('/onboarding-config', requireOnboardingMode, async (c) => {
  const siteKey = await c.env.KV.get(SETUP_KEYS.TURNSTILE_SITE_KEY);
  return c.json({
    active: true,
    turnstileSiteKey: siteKey,
  });
});

// REQ-LANDING-002: public config for the landing contact form. Exposes only
// the Turnstile site key (public by definition).
app.get('/contact-config', async (c) => {
  const siteKey = await c.env.KV.get(SETUP_KEYS.TURNSTILE_SITE_KEY);
  return c.json({ turnstileSiteKey: siteKey });
});

app.post('/waitlist', requireOnboardingMode, waitlistRateLimiter, async (c) => {
  const body = await parseJsonBody(c, WaitlistRequestSchema);
  const remoteIp = c.req.header('CF-Connecting-IP') || null;

  const { resendApiKey, adminRecipients } = await requireVerifiedSubmission({
    env: c.env,
    turnstileToken: body.turnstileToken,
    remoteIp,
    unavailableCode: 'WAITLIST_NOT_CONFIGURED',
    noRecipientCode: 'WAITLIST_NO_ADMIN_RECIPIENT',
    logContext: { email: body.email },
  });

  const submittedEmail = body.email.replace(/[\r\n]/g, '');
  const submittedAtIso = new Date().toISOString();
  await sendNotificationEmail({
    resendApiKey,
    from: c.env.RESEND_EMAIL || 'Codeflare Waitlist <onboarding@resend.dev>',
    to: adminRecipients,
    subject: `Codeflare waitlist request: ${submittedEmail}`,
    html: [
      '<h2>New Codeflare waitlist submission</h2>',
      `<p><strong>Email:</strong> ${escapeXml(body.email)}</p>`,
      `<p><strong>Submitted at:</strong> ${submittedAtIso}</p>`,
      `<p><strong>IP:</strong> ${escapeXml(remoteIp || 'unknown')}</p>`,
    ].join('\n'),
    replyTo: submittedEmail,
    errorCode: 'WAITLIST_EMAIL_FAILED',
  });

  logger.info('Waitlist submission accepted', { email: body.email });
  return c.json({ success: true });
});

// REQ-LANDING-002: demo-request submissions are relayed to admins as email
// and intentionally never persisted (privacy: the landing page promises
// "not stored"). All user-controlled fields are escaped before rendering.
app.post('/contact', contactRateLimiter, async (c) => {
  const body = await parseJsonBody(c, ContactRequestSchema);
  const remoteIp = c.req.header('CF-Connecting-IP') || null;

  const { resendApiKey, adminRecipients } = await requireVerifiedSubmission({
    env: c.env,
    turnstileToken: body.turnstileToken,
    remoteIp,
    unavailableCode: 'CONTACT_NOT_CONFIGURED',
    noRecipientCode: 'CONTACT_NO_ADMIN_RECIPIENT',
    logContext: { email: body.email, topic: body.topic },
  });

  const submittedAtIso = new Date().toISOString();
  await sendNotificationEmail({
    resendApiKey,
    from: c.env.RESEND_EMAIL || 'Codeflare Contact <onboarding@resend.dev>',
    to: adminRecipients,
    subject: `Codeflare enterprise inquiry [${body.topic}]: ${body.name.replace(/[\r\n]/g, '')}`,
    html: [
      '<h2>New Codeflare enterprise inquiry</h2>',
      `<p><strong>Name:</strong> ${escapeXml(body.name)}</p>`,
      `<p><strong>Email:</strong> ${escapeXml(body.email)}</p>`,
      `<p><strong>Company:</strong> ${escapeXml(body.company || 'not provided')}</p>`,
      `<p><strong>Topic:</strong> ${escapeXml(body.topic)}</p>`,
      `<p><strong>Message:</strong></p>`,
      `<p>${escapeXml(body.message)}</p>`,
      `<p><strong>Submitted at:</strong> ${submittedAtIso}</p>`,
      `<p><strong>IP:</strong> ${escapeXml(remoteIp || 'unknown')}</p>`,
    ].join('\n'),
    replyTo: body.email.replace(/[\r\n]/g, ''),
    errorCode: 'CONTACT_EMAIL_FAILED',
  });

  logger.info('Contact submission accepted', { email: body.email, topic: body.topic });
  return c.json({ success: true });
});

// GET /public/tiers — subscribable tier config (no auth required)
app.get('/tiers', async (c) => {
  const allTiers = await getTierConfig(c.env.KV);
  const subscribable = allTiers.filter((t) => SUBSCRIBABLE_TIER_IDS.has(t.id as string));
  return c.json({ tiers: subscribable });
});

export default app;
