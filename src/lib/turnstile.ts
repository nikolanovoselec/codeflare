interface TurnstileVerificationResult {
  success: boolean;
  'error-codes'?: string[];
}

export async function verifyTurnstileToken(
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
