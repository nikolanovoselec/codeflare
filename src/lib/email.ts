/**
 * Email sending via Resend API.
 * Exports: sendEmail (boolean), sendWelcomeEmail (boolean),
 * sendSubscriptionEmail (boolean), sendSubscriptionAdminNotification (boolean),
 * sendTierChangeNotification (void).
 * Non-fatal: sendEmail/send*Email return boolean success, never throw.
 * sendTierChangeNotification returns void (fires user + admin emails sequentially).
 *
 * Note: Renewal/payment emails are handled by Stripe native customer emails.
 */
import { escapeXml } from './xml-utils';
import { createLogger } from './logger';
import { toError } from './error-types';

const logger = createLogger('email');

// ── Shared email helpers ──

const TD_STYLE = 'padding:4px 16px 4px 0;color:#888';

/** Derive user-facing mode label from session mode. */
export function getModeLabel(mode?: string): string {
  return mode === 'advanced' ? 'Pro' : 'Standard';
}

/** Build Previous/New plan comparison rows for subscription emails. */
export function buildPlanChangeRows(opts: {
  previousTierName?: string;
  tierName: string;
  previousMode?: string;
  sessionMode?: string;
}): string[] {
  const prevModeLabel = getModeLabel(opts.previousMode);
  const modeLabel = getModeLabel(opts.sessionMode);
  return [
    '<table style="border-collapse:collapse;margin:16px 0">',
    `<tr><td style="${TD_STYLE}">Previous</td><td>${escapeXml(opts.previousTierName ?? opts.tierName)} (${prevModeLabel})</td></tr>`,
    `<tr><td style="${TD_STYLE}">New</td><td><strong>${escapeXml(opts.tierName)} (${modeLabel})</strong></td></tr>`,
    '</table>',
  ];
}

/** Build subscription detail table rows (Compute, Sessions, Price, Trial, Activated). */
export function buildSubscriptionDetailRows(opts: {
  monthlyHours?: string;
  maxSessions?: number;
  price?: string;
  trialHours?: number;
  subscribedAt?: string;
}): string[] {
  const rows: string[] = ['<table style="border-collapse:collapse;margin:16px 0">'];
  if (opts.monthlyHours) {
    rows.push(`<tr><td style="${TD_STYLE}">Compute</td><td><strong>${escapeXml(opts.monthlyHours)}</strong> / month</td></tr>`);
  }
  if (opts.maxSessions) {
    rows.push(`<tr><td style="${TD_STYLE}">Sessions</td><td><strong>${opts.maxSessions}</strong> concurrent</td></tr>`);
  }
  if (opts.price) {
    rows.push(`<tr><td style="${TD_STYLE}">Price</td><td><strong>${escapeXml(opts.price)}</strong> / month</td></tr>`);
  }
  if (opts.trialHours && opts.trialHours > 0) {
    rows.push(`<tr><td style="${TD_STYLE}">Trial</td><td><strong>${opts.trialHours}h</strong> free compute before billing</td></tr>`);
  } else if (opts.price) {
    rows.push(`<tr><td style="${TD_STYLE}">Billing</td><td>Monthly billing active</td></tr>`);
  }
  if (opts.subscribedAt) {
    const date = new Date(opts.subscribedAt);
    const formatted = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      + ' at ' + date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
    rows.push(`<tr><td style="${TD_STYLE}">Activated</td><td>${escapeXml(formatted)}</td></tr>`);
  }
  rows.push('</table>');
  return rows;
}

interface SendEmailOptions {
  to: string[];
  subject: string;
  html: string;
  replyTo?: string;
  env: {
    RESEND_API_KEY?: string;
    RESEND_EMAIL?: string;
  };
}

/**
 * Send an email via the Resend API.
 * Returns true on success, false on failure (missing config, empty recipients, API error).
 * Never throws — callers can fire-and-forget.
 */
export async function sendEmail(opts: SendEmailOptions): Promise<boolean> {
  const { to, subject, html, replyTo, env } = opts;

  if (!env.RESEND_API_KEY || to.length === 0) {
    return false;
  }

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        from: env.RESEND_EMAIL || 'Codeflare <onboarding@resend.dev>',
        to,
        subject,
        html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    if (!resp.ok) {
      logger.error('Email send failed', new Error(`Resend API ${resp.status}`), { to: opts.to, subject: opts.subject });
    }
    return resp.ok;
  } catch (err) {
    logger.error('Email send error', toError(err));
    return false;
  }
}

/**
 * Send a welcome email when a new user registers (JIT provisioned).
 */
export async function sendWelcomeEmail(opts: {
  userEmail: string;
  instanceUrl?: string;
  env: { RESEND_API_KEY?: string; RESEND_EMAIL?: string };
}): Promise<boolean> {
  const safeEmail = escapeXml(opts.userEmail);
  const subscribeLink = opts.instanceUrl
    ? `<p><a href="${escapeXml(opts.instanceUrl)}/app/subscribe">Choose your plan</a></p>`
    : '';
  return sendEmail({
    to: [opts.userEmail],
    subject: 'Welcome to Codeflare',
    html: [
      '<h2>Welcome to Codeflare</h2>',
      `<p>Hi ${safeEmail},</p>`,
      '<p>Your account has been created. To get started, choose a subscription plan that fits your needs.</p>',
      '<p>Codeflare is the enterprise agentic engine: autonomous agents that build, review, test, and ship inside your own cloud boundary, governed, attributed, and encrypted. Persistent memory across sessions, advanced skills and workflows, voice input, and more. All from any device with a browser.</p>',
      subscribeLink,
    ].filter(Boolean).join('\n'),
    env: opts.env,
  });
}

/**
 * Send a confirmation email to a user who just requested Codeflare access
 * (onboarding mode). Non-fatal — returns false on missing config / API error.
 */
export async function sendAccessRequestConfirmation(opts: {
  userEmail: string;
  env: { RESEND_API_KEY?: string; RESEND_EMAIL?: string };
}): Promise<boolean> {
  const safeEmail = escapeXml(opts.userEmail);
  // Voice and lines mirror the landing (HERO + SECURITY copy) so the first email
  // a prospect gets matches the page they just left. Light, inline-styled HTML so
  // it renders consistently across mail clients. No em/en dashes in rendered copy.
  const accent = '#ff5c3c';
  const ink = '#0a0a0c';
  const body =
    "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;" +
    'max-width:480px;margin:0 auto;padding:8px 4px;color:#1a1a1f;line-height:1.6;font-size:15px';
  return sendEmail({
    to: [opts.userEmail],
    subject: "You're on the list for Codeflare",
    html: [
      `<div style="${body}">`,
      `<p style="font-weight:700;letter-spacing:-0.01em;font-size:18px;color:${accent};margin:0 0 28px">codeflare</p>`,
      `<h1 style="font-size:24px;letter-spacing:-0.02em;line-height:1.25;margin:0 0 16px;color:${ink}">You're on the list</h1>`,
      `<p style="margin:0 0 16px">Hi ${safeEmail},</p>`,
      "<p style=\"margin:0 0 16px\">Thanks for requesting access to Codeflare. Your request is in and queued for review. We'll email you the moment your workspace is approved, so there is nothing more you need to do right now.</p>",
      `<div style="height:1px;background:#e6e6ea;margin:28px 0"></div>`,
      `<p style="margin:0 0 12px;color:#6b6b76;font-size:12px;text-transform:uppercase;letter-spacing:0.1em">While you wait</p>`,
      `<p style="margin:0 0 14px;font-size:19px;font-weight:600;letter-spacing:-0.01em;color:${ink}">This is not a coding assistant.</p>`,
      '<p style="margin:0 0 16px">Codeflare runs governed engineering agents inside your own estate. Each change is backed by a spec, proven by tests, documented, and handed to your team to approve, whether that is a pull request to merge or a change to run.</p>',
      '<p style="margin:0 0 16px">Every session authenticates through your identity provider, runs in an isolated container in your own tenancy, and reaches models only through your AI Gateway. Your code never leaves your boundary.</p>',
      '<p style="margin:28px 0 4px">Talk soon,</p>',
      '<p style="margin:0 0 28px">The Codeflare team</p>',
      `<p style="color:#9a9aa4;font-size:13px;margin:0">Need help, or did not make this request? Just reply to this email.</p>`,
      '</div>',
    ].join('\n'),
    env: opts.env,
  });
}

/**
 * Send a subscription confirmation or plan change email.
 */
export async function sendSubscriptionEmail(opts: {
  userEmail: string;
  tierName: string;
  previousTierName?: string;
  monthlyHours: string;
  maxSessions: number;
  trialHours: number;
  sessionMode?: string;
  previousMode?: string;
  price?: string;
  subscribedAt?: string;
  instanceUrl?: string;
  env: { RESEND_API_KEY?: string; RESEND_EMAIL?: string };
}): Promise<boolean> {
  const { userEmail, tierName, previousTierName, monthlyHours, maxSessions, trialHours, sessionMode, previousMode, price, subscribedAt, instanceUrl, env } = opts;
  const safeTier = escapeXml(tierName);
  const isChange = !!previousTierName || !!previousMode;
  const modeLabel = getModeLabel(sessionMode);
  const subject = isChange ? `Plan changed to ${tierName} (${modeLabel})` : `Your Codeflare plan: ${tierName} (${modeLabel})`;

  const lines = [
    `<h2>${isChange ? 'Plan Changed' : 'Subscription Confirmed'}</h2>`,
  ];

  if (isChange) {
    lines.push(...buildPlanChangeRows({ previousTierName, tierName, previousMode, sessionMode }));
  } else {
    lines.push(`<p>Your Codeflare plan is now <strong>${safeTier} (${modeLabel})</strong>.</p>`);
  }

  lines.push(...buildSubscriptionDetailRows({ monthlyHours, maxSessions, price, trialHours, subscribedAt }));

  lines.push('<p>You can manage your subscription — change plan, update payment method, or cancel — anytime from your profile in Codeflare.</p>');

  if (instanceUrl) {
    lines.push(`<p><a href="${escapeXml(instanceUrl)}">Open Codeflare</a></p>`);
  }

  lines.push('<p style="color:#888;font-size:0.875em">Need help? Just reply to this email.</p>');

  return sendEmail({ to: [userEmail], subject, html: lines.join('\n'), replyTo: env.RESEND_EMAIL, env });
}

/**
 * Send admin notification when a user subscribes or changes plan.
 */
export async function sendSubscriptionAdminNotification(opts: {
  userEmail: string;
  tierName: string;
  previousTierName?: string;
  sessionMode?: string;
  previousMode?: string;
  monthlyHours?: string;
  maxSessions?: number;
  price?: string;
  trialHours?: number;
  subscribedAt?: string;
  adminEmails: string[];
  env: { RESEND_API_KEY?: string; RESEND_EMAIL?: string };
}): Promise<boolean> {
  const { userEmail, tierName, previousTierName, sessionMode, previousMode, monthlyHours, maxSessions, price, trialHours, subscribedAt, adminEmails, env } = opts;
  if (adminEmails.length === 0) return false;

  const safeUser = escapeXml(userEmail);
  const safeTier = escapeXml(tierName);
  const isChange = !!previousTierName || !!previousMode;
  const modeLabel = getModeLabel(sessionMode);

  const subject = isChange
    ? `Plan change: ${userEmail} → ${tierName} (${modeLabel})`
    : `New subscriber: ${userEmail} → ${tierName} (${modeLabel})`;

  const lines = [
    `<h2>${isChange ? 'Plan Change' : 'New Subscriber'}</h2>`,
    `<p><strong>User:</strong> ${safeUser}</p>`,
  ];

  if (isChange) {
    lines.push(...buildPlanChangeRows({ previousTierName, tierName, previousMode, sessionMode }));
  } else {
    lines.push(`<p><strong>Plan:</strong> ${safeTier} (${modeLabel})</p>`);
  }

  lines.push(...buildSubscriptionDetailRows({ monthlyHours, maxSessions, price, trialHours, subscribedAt }));

  return sendEmail({ to: adminEmails, subject, html: lines.join('\n'), replyTo: userEmail, env });
}

/**
 * Send a tier change notification email to a user and admin.
 */
export async function sendTierChangeNotification(opts: {
  userEmail: string;
  previousTier: string;
  newTier: string;
  changedBy: string;
  adminEmails: string[];
  env: { RESEND_API_KEY?: string; RESEND_EMAIL?: string };
}): Promise<void> {
  const { userEmail, previousTier, newTier, changedBy, adminEmails, env } = opts;

  // Escape all interpolated values to prevent HTML injection
  const safeUser = escapeXml(userEmail);
  const safePrev = escapeXml(previousTier);
  const safeNew = escapeXml(newTier);
  const safeBy = escapeXml(changedBy);

  // Notify user
  await sendEmail({
    to: [userEmail],
    subject: `Your Codeflare plan has been updated to ${newTier}`,
    html: [
      '<h2>Plan Update</h2>',
      `<p>Your Codeflare subscription has been changed from <strong>${safePrev}</strong> to <strong>${safeNew}</strong>.</p>`,
      `<p>Changed by: ${safeBy}</p>`,
    ].join('\n'),
    env,
  });

  // Notify admins
  if (adminEmails.length > 0) {
    await sendEmail({
      to: adminEmails,
      subject: `Tier change: ${userEmail} → ${newTier}`,
      html: [
        '<h2>Tier Change Notification</h2>',
        `<p><strong>User:</strong> ${safeUser}</p>`,
        `<p><strong>Previous tier:</strong> ${safePrev}</p>`,
        `<p><strong>New tier:</strong> ${safeNew}</p>`,
        `<p><strong>Changed by:</strong> ${safeBy}</p>`,
      ].join('\n'),
      replyTo: changedBy.includes('@') ? changedBy : undefined,
      env,
    });
  }
}

/**
 * Send admin notification for an access or Team plan inquiry (CF-020).
 * When `plan` is provided, the email is formatted as a Team/Enterprise inquiry
 * with a call to action. Otherwise it falls back to a generic access request.
 */
export async function sendAccessRequestNotification(opts: {
  userEmail: string;
  requestedAt: string;
  remoteIp: string | null;
  plan?: string;
  adminEmails: string[];
  env: { RESEND_API_KEY?: string; RESEND_EMAIL?: string };
}): Promise<boolean> {
  if (opts.adminEmails.length === 0) return false;
  const safeEmail = escapeXml(opts.userEmail);
  const safeIp = escapeXml(opts.remoteIp || 'unknown');
  const safePlan = opts.plan ? escapeXml(opts.plan) : null;

  const date = new Date(opts.requestedAt);
  const formattedDate = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    + ' at ' + date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });

  const subject = safePlan
    ? `${safePlan} plan inquiry: ${opts.userEmail.replace(/[\r\n]/g, '')}`
    : `Codeflare access request: ${opts.userEmail.replace(/[\r\n]/g, '')}`;

  const lines = safePlan
    ? [
        `<h2>${safePlan} Plan Inquiry</h2>`,
        `<p>A user has requested information about the <strong>${safePlan}</strong> plan.</p>`,
        '<table style="border-collapse:collapse;margin:16px 0">',
        `<tr><td style="padding:4px 16px 4px 0;color:#888">Email</td><td><strong>${safeEmail}</strong></td></tr>`,
        `<tr><td style="padding:4px 16px 4px 0;color:#888">Plan</td><td><strong>${safePlan}</strong> (unlimited compute, 10 parallel sessions)</td></tr>`,
        `<tr><td style="padding:4px 16px 4px 0;color:#888">Requested</td><td>${escapeXml(formattedDate)}</td></tr>`,
        `<tr><td style="padding:4px 16px 4px 0;color:#888">IP</td><td>${safeIp}</td></tr>`,
        '</table>',
        '<hr style="border:none;border-top:1px solid #ddd;margin:24px 0" />',
        `<p><strong>Next step:</strong> Reply to this email to reach <strong>${safeEmail}</strong> directly and discuss pricing, onboarding, or a demo.</p>`,
      ]
    : [
        '<h2>New Codeflare access request</h2>',
        `<p><strong>Email:</strong> ${safeEmail}</p>`,
        `<p><strong>Requested at:</strong> ${escapeXml(formattedDate)}</p>`,
        `<p><strong>IP:</strong> ${safeIp}</p>`,
      ];

  return sendEmail({
    to: opts.adminEmails,
    subject,
    html: lines.join('\n'),
    replyTo: opts.userEmail.replace(/[\r\n]/g, ''),
    env: opts.env,
  });
}
