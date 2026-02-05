import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../types';
import { createRateLimiter } from '../../middleware/rate-limit';
import { AppError, ValidationError } from '../../lib/error-types';
import { getAllUsers } from '../../lib/access-policy';
import { isOnboardingLandingPageActive } from '../../lib/onboarding';
import { escapeXml } from '../../lib/xml-utils';
import { createLogger } from '../../lib/logger';

const logger = createLogger('public-routes');

const WaitlistRequestSchema = z.object({
  email: z.string().email('Valid email is required'),
  turnstileToken: z.string().min(1, 'Turnstile token is required'),
});

interface TurnstileVerificationResult {
  success: boolean;
  'error-codes'?: string[];
}

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

async function verifyTurnstileToken(
  token: string,
  secret: string,
  remoteIp: string | null
): Promise<TurnstileVerificationResult> {
  const body = new URLSearchParams();
  body.append('secret', secret);
  body.append('response', token);
  if (remoteIp) {
    body.append('remoteip', remoteIp);
  }

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    return { success: false, 'error-codes': [`http_${response.status}`] };
  }

  return response.json() as Promise<TurnstileVerificationResult>;
}

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
      subject: `Codeflare waitlist request: ${submittedEmail}`,
      html: [
        '<h2>New Codeflare waitlist submission</h2>',
        `<p><strong>Email:</strong> ${escapeXml(submittedEmail)}</p>`,
        `<p><strong>Submitted at:</strong> ${submittedAtIso}</p>`,
        `<p><strong>IP:</strong> ${escapeXml(remoteIp || 'unknown')}</p>`,
      ].join('\n'),
      reply_to: submittedEmail,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new AppError('WAITLIST_EMAIL_FAILED', 502, `Resend request failed: ${response.status} ${text}`);
  }
}

app.get('/onboarding-config', async (c) => {
  const siteKey = await c.env.KV.get('setup:turnstile_site_key');
  return c.json({
    active: true,
    turnstileSiteKey: siteKey,
  });
});

app.post('/waitlist', waitlistRateLimiter, async (c) => {
  const body = await c.req.json();
  const parsed = WaitlistRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0].message);
  }

  const turnstileSecret = c.env.TURNSTILE_SECRET_KEY
    || await c.env.KV.get('setup:turnstile_secret_key');
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
    from: c.env.WAITLIST_FROM_EMAIL || 'Codeflare Waitlist <onboarding@resend.dev>',
    to: adminRecipients,
    submittedEmail: parsed.data.email,
    submittedAtIso,
    remoteIp,
  });

  logger.info('Waitlist submission accepted', { email: parsed.data.email });
  return c.json({ success: true });
});

export default app;

