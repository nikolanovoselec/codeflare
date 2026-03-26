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

const logger = createLogger('email');

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
    logger.error('Email send error', err instanceof Error ? err : new Error(String(err)));
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
      '<p>Codeflare gives you a browser-based cloud IDE with 5 AI coding agents, a full Linux terminal, file browser, and R2 cloud sync — ready to code on any device.</p>',
      subscribeLink,
    ].filter(Boolean).join('\n'),
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
  const modeLabel = sessionMode === 'advanced' ? 'Pro' : 'Standard';
  const subject = isChange ? `Plan changed to ${tierName} (${modeLabel})` : `Your Codeflare plan: ${tierName} (${modeLabel})`;

  const lines = [
    `<h2>${isChange ? 'Plan Changed' : 'Subscription Confirmed'}</h2>`,
  ];

  if (isChange) {
    const prevModeLabel = previousMode === 'advanced' ? 'Pro' : 'Standard';
    lines.push(
      '<table style="border-collapse:collapse;margin:16px 0">',
      `<tr><td style="padding:4px 16px 4px 0;color:#888">Previous</td><td>${escapeXml(previousTierName ?? tierName)} (${prevModeLabel})</td></tr>`,
      `<tr><td style="padding:4px 16px 4px 0;color:#888">New</td><td><strong>${safeTier} (${modeLabel})</strong></td></tr>`,
      '</table>',
    );
  } else {
    lines.push(`<p>Your Codeflare plan is now <strong>${safeTier} (${modeLabel})</strong>.</p>`);
  }

  lines.push(
    '<table style="border-collapse:collapse;margin:16px 0">',
    `<tr><td style="padding:4px 16px 4px 0;color:#888">Compute</td><td><strong>${escapeXml(monthlyHours)}</strong> / month</td></tr>`,
    `<tr><td style="padding:4px 16px 4px 0;color:#888">Sessions</td><td><strong>${maxSessions}</strong> concurrent</td></tr>`,
  );

  if (price) {
    lines.push(`<tr><td style="padding:4px 16px 4px 0;color:#888">Price</td><td><strong>${escapeXml(price)}</strong> / month</td></tr>`);
  }

  if (trialHours > 0) {
    lines.push(`<tr><td style="padding:4px 16px 4px 0;color:#888">Trial</td><td><strong>${trialHours}h</strong> free compute before billing</td></tr>`);
  } else if (price) {
    lines.push(`<tr><td style="padding:4px 16px 4px 0;color:#888">Billing</td><td>Monthly billing active</td></tr>`);
  }

  if (subscribedAt) {
    const date = new Date(subscribedAt);
    const formatted = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      + ' at ' + date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
    lines.push(`<tr><td style="padding:4px 16px 4px 0;color:#888">Activated</td><td>${escapeXml(formatted)}</td></tr>`);
  }

  lines.push('</table>');

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
  const modeLabel = sessionMode === 'advanced' ? 'Pro' : 'Standard';

  const subject = isChange
    ? `Plan change: ${userEmail} → ${tierName} (${modeLabel})`
    : `New subscriber: ${userEmail} → ${tierName} (${modeLabel})`;

  const lines = [
    `<h2>${isChange ? 'Plan Change' : 'New Subscriber'}</h2>`,
    `<p><strong>User:</strong> ${safeUser}</p>`,
  ];

  if (isChange) {
    const prevModeLabel = previousMode === 'advanced' ? 'Pro' : 'Standard';
    lines.push(
      '<table style="border-collapse:collapse;margin:16px 0">',
      `<tr><td style="padding:4px 16px 4px 0;color:#888">Previous</td><td>${escapeXml(previousTierName ?? tierName)} (${prevModeLabel})</td></tr>`,
      `<tr><td style="padding:4px 16px 4px 0;color:#888">New</td><td><strong>${safeTier} (${modeLabel})</strong></td></tr>`,
      '</table>',
    );
  } else {
    lines.push(`<p><strong>Plan:</strong> ${safeTier} (${modeLabel})</p>`);
  }

  lines.push('<table style="border-collapse:collapse;margin:16px 0">');
  if (monthlyHours) {
    lines.push(`<tr><td style="padding:4px 16px 4px 0;color:#888">Compute</td><td><strong>${escapeXml(monthlyHours)}</strong> / month</td></tr>`);
  }
  if (maxSessions) {
    lines.push(`<tr><td style="padding:4px 16px 4px 0;color:#888">Sessions</td><td><strong>${maxSessions}</strong> concurrent</td></tr>`);
  }
  if (price) {
    lines.push(`<tr><td style="padding:4px 16px 4px 0;color:#888">Price</td><td><strong>${escapeXml(price)}</strong> / month</td></tr>`);
  }
  if (trialHours && trialHours > 0) {
    lines.push(`<tr><td style="padding:4px 16px 4px 0;color:#888">Trial</td><td><strong>${trialHours}h</strong> free compute before billing</td></tr>`);
  } else if (price) {
    lines.push(`<tr><td style="padding:4px 16px 4px 0;color:#888">Billing</td><td>Monthly billing active</td></tr>`);
  }
  if (subscribedAt) {
    const date = new Date(subscribedAt);
    const formatted = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      + ' at ' + date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
    lines.push(`<tr><td style="padding:4px 16px 4px 0;color:#888">Activated</td><td>${escapeXml(formatted)}</td></tr>`);
  }
  lines.push('</table>');

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
 * Send admin notification for a new access request (CF-020).
 * Replaces raw fetch call in auth.ts request-access handler.
 */
export async function sendAccessRequestNotification(opts: {
  userEmail: string;
  requestedAt: string;
  remoteIp: string | null;
  adminEmails: string[];
  env: { RESEND_API_KEY?: string; RESEND_EMAIL?: string };
}): Promise<boolean> {
  if (opts.adminEmails.length === 0) return false;
  const safeEmail = escapeXml(opts.userEmail);
  const safeIp = escapeXml(opts.remoteIp || 'unknown');
  return sendEmail({
    to: opts.adminEmails,
    subject: `Codeflare access request: ${opts.userEmail.replace(/[\r\n]/g, '')}`,
    html: [
      '<h2>New Codeflare access request</h2>',
      `<p><strong>Email:</strong> ${safeEmail}</p>`,
      `<p><strong>Requested at:</strong> ${opts.requestedAt}</p>`,
      `<p><strong>IP:</strong> ${safeIp}</p>`,
    ].join('\n'),
    replyTo: opts.userEmail.replace(/[\r\n]/g, ''),
    env: opts.env,
  });
}
