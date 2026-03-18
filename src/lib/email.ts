/**
 * Generic email sending helper via Resend API.
 * Extracted from the inline Resend code in routes/auth.ts.
 * Non-fatal: returns boolean success, never throws.
 */

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
    await fetch('https://api.resend.com/emails', {
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
    return true;
  } catch {
    return false;
  }
}
