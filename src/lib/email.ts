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
