import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../types';
import { createRateLimiter } from '../../middleware/rate-limit';
import { AppError, ValidationError } from '../../lib/error-types';
import { getAllUsers } from '../../lib/access-policy';
import { isOnboardingLandingPageActive } from '../../lib/onboarding';
import { getTierConfig, SUBSCRIBABLE_TIER_IDS } from '../../lib/subscription';
import { escapeXml } from '../../lib/xml-utils';
import { createLogger } from '../../lib/logger';
import { parseJsonBody, firstZodError } from '../../lib/request-helpers';
import { verifyTurnstileToken } from '../../lib/turnstile';
import { SETUP_KEYS } from '../../lib/kv-keys';

const logger = createLogger('public-routes');

const WaitlistRequestSchema = z.object({
  email: z.string().email('Valid email is required'),
  turnstileToken: z.string().min(1, 'Turnstile token is required'),
});

const app = new Hono<{ Bindings: Env }>();

const waitlistRateLimiter = createRateLimiter({
  windowMs: 60_000,
  maxRequests: 5,
  keyPrefix: 'waitlist-submit',
});

app.use('*', async (c, next) => {
  if (!isOnboardingLandingPageActive(c.env.ONBOARDING_LANDING_PAGE)) {
    return c.json({ error: 'Not found' }, 404);
  }
  return next();
});


async function sendWaitlistEmail(params: {
  resendApiKey: string;
  from: string;
  to: string[];
  submittedEmail: string;
  submittedAtIso: string;
  remoteIp: string | null;
}): Promise<void> {
  const { resendApiKey, from, to, submittedEmail, submittedAtIso, remoteIp } = params;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${resendApiKey}`,
    },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      from,
      to,
      subject: `Codeflare waitlist request: ${submittedEmail.replace(/[\r\n]/g, '')}`,
      html: [
        '<h2>New Codeflare waitlist submission</h2>',
        `<p><strong>Email:</strong> ${escapeXml(submittedEmail)}</p>`,
        `<p><strong>Submitted at:</strong> ${submittedAtIso}</p>`,
        `<p><strong>IP:</strong> ${escapeXml(remoteIp || 'unknown')}</p>`,
      ].join('\n'),
      reply_to: submittedEmail.replace(/[\r\n]/g, ''),
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new AppError('WAITLIST_EMAIL_FAILED', 502, `Resend request failed: ${response.status} ${text}`);
  }
}

app.get('/onboarding-config', async (c) => {
  const siteKey = await c.env.KV.get(SETUP_KEYS.TURNSTILE_SITE_KEY);
  return c.json({
    active: true,
    turnstileSiteKey: siteKey,
  });
});

app.post('/waitlist', waitlistRateLimiter, async (c) => {
  const body = await parseJsonBody(c);
  const parsed = WaitlistRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(firstZodError(parsed.error));
  }

  const turnstileSecret = c.env.TURNSTILE_SECRET_KEY
    || await c.env.KV.get(SETUP_KEYS.TURNSTILE_SECRET_KEY);
  const resendApiKey = c.env.RESEND_API_KEY;

  if (!turnstileSecret || !resendApiKey) {
    throw new AppError(
      'WAITLIST_NOT_CONFIGURED',
      503,
      'Waitlist is not fully configured',
      'Waitlist temporarily unavailable'
    );
  }

  const users = await getAllUsers(c.env.KV);
  const adminRecipients = users.filter((u) => u.role === 'admin').map((u) => u.email);
  if (adminRecipients.length === 0) {
    throw new AppError(
      'WAITLIST_NO_ADMIN_RECIPIENT',
      503,
      'No admin recipients configured',
      'Waitlist temporarily unavailable'
    );
  }

  const remoteIp = c.req.header('CF-Connecting-IP') || null;
  const verification = await verifyTurnstileToken(
    parsed.data.turnstileToken,
    turnstileSecret,
    remoteIp
  );

  if (!verification.success) {
    logger.warn('Turnstile verification failed', {
      email: parsed.data.email,
      errorCodes: verification['error-codes'],
    });
    throw new ValidationError('CAPTCHA verification failed');
  }

  const submittedAtIso = new Date().toISOString();
  await sendWaitlistEmail({
    resendApiKey,
    from: c.env.RESEND_EMAIL || 'Codeflare Waitlist <onboarding@resend.dev>',
    to: adminRecipients,
    submittedEmail: parsed.data.email,
    submittedAtIso,
    remoteIp,
  });

  logger.info('Waitlist submission accepted', { email: parsed.data.email });
  return c.json({ success: true });
});

// GET /public/tiers — subscribable tier config (no auth required)
app.get('/tiers', async (c) => {
  const allTiers = await getTierConfig(c.env.KV);
  const subscribable = allTiers.filter((t) => SUBSCRIBABLE_TIER_IDS.has(t.id as string));
  return c.json({ tiers: subscribable });
});

export default app;

