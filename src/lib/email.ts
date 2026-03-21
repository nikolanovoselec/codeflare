/**
 * Generic email sending helper via Resend API.
 * Extracted from the inline Resend code in routes/auth.ts.
 * Non-fatal: returns boolean success, never throws.
 */
import { escapeXml } from './xml-utils';

interface SendEmailOptions {
  to: string[];
  subject: string;
  html: string;
  replyTo?: string;
  env: {
    RESEND_API_KEY?: string;
    WAITLIST_FROM_EMAIL?: string;
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
        from: env.WAITLIST_FROM_EMAIL || 'Codeflare <onboarding@resend.dev>',
        to,
        subject,
        html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Send a welcome email when a new user registers (JIT provisioned).
 */
export async function sendWelcomeEmail(opts: {
  userEmail: string;
  env: { RESEND_API_KEY?: string; WAITLIST_FROM_EMAIL?: string };
}): Promise<boolean> {
  const safeEmail = escapeXml(opts.userEmail);
  return sendEmail({
    to: [opts.userEmail],
    subject: 'Welcome to Codeflare',
    html: [
      '<h2>Welcome to Codeflare</h2>',
      `<p>Hi ${safeEmail},</p>`,
      '<p>Your account has been created. To get started, choose a subscription plan that fits your needs.</p>',
      '<p>Codeflare gives you a browser-based cloud IDE with 5 AI coding agents, a full Linux terminal, file browser, and R2 cloud sync — ready to code on any device.</p>',
      '<p><a href="https://codeflare.novoselec.ch/app/subscribe">Choose your plan</a></p>',
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
  env: { RESEND_API_KEY?: string; WAITLIST_FROM_EMAIL?: string };
}): Promise<boolean> {
  const { userEmail, tierName, previousTierName, monthlyHours, maxSessions, trialHours, env } = opts;
  const safeTier = escapeXml(tierName);
  const isChange = !!previousTierName;
  const subject = isChange ? `Plan changed to ${tierName}` : `Your Codeflare plan: ${tierName}`;

  const lines = [
    `<h2>${isChange ? 'Plan Changed' : 'Subscription Confirmed'}</h2>`,
    `<p>Your Codeflare plan is now <strong>${safeTier}</strong>.</p>`,
  ];

  if (isChange && previousTierName) {
    lines.push(`<p>Previous plan: ${escapeXml(previousTierName)}</p>`);
  }

  lines.push(
    '<table style="border-collapse:collapse;margin:16px 0">',
    `<tr><td style="padding:4px 16px 4px 0;color:#888">Compute</td><td><strong>${escapeXml(monthlyHours)}</strong> / month</td></tr>`,
    `<tr><td style="padding:4px 16px 4px 0;color:#888">Sessions</td><td><strong>${maxSessions}</strong> concurrent</td></tr>`,
  );

  if (trialHours > 0) {
    lines.push(`<tr><td style="padding:4px 16px 4px 0;color:#888">Trial</td><td><strong>${trialHours}h</strong> free</td></tr>`);
  }

  lines.push('</table>');

  return sendEmail({ to: [userEmail], subject, html: lines.join('\n'), env });
}

/**
 * Send a subscription renewal email (stub — not wired yet, for future billing integration).
 * TODO: Wire this into billing/payment processor when integrated.
 */
export async function sendRenewalEmail(opts: {
  userEmail: string;
  tierName: string;
  monthlyHours: string;
  maxSessions: number;
  env: { RESEND_API_KEY?: string; WAITLIST_FROM_EMAIL?: string };
}): Promise<boolean> {
  const { userEmail, tierName, monthlyHours, maxSessions, env } = opts;
  const safeTier = escapeXml(tierName);

  return sendEmail({
    to: [userEmail],
    subject: `Codeflare subscription renewed — ${tierName}`,
    html: [
      '<h2>Subscription Renewed</h2>',
      `<p>Your <strong>${safeTier}</strong> plan has been renewed for a new billing period.</p>`,
      '<table style="border-collapse:collapse;margin:16px 0">',
      `<tr><td style="padding:4px 16px 4px 0;color:#888">Plan</td><td><strong>${safeTier}</strong></td></tr>`,
      `<tr><td style="padding:4px 16px 4px 0;color:#888">Compute</td><td><strong>${escapeXml(monthlyHours)}</strong> / month</td></tr>`,
      `<tr><td style="padding:4px 16px 4px 0;color:#888">Sessions</td><td><strong>${maxSessions}</strong> concurrent</td></tr>`,
      '</table>',
    ].join('\n'),
    env,
  });
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
  env: { RESEND_API_KEY?: string; WAITLIST_FROM_EMAIL?: string };
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
