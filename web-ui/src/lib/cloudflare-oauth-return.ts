export type CloudflareReturnOutcome = 'select-account' | 'error' | 'no-accounts';

export function parseCloudflareReturn(value: string | null): CloudflareReturnOutcome | undefined {
  if (value === 'select-account' || value === 'error' || value === 'no-accounts') return value;
}

export function cloudflareRetryMessage(outcome: CloudflareReturnOutcome | undefined): string | undefined {
  if (outcome === 'no-accounts') {
    return 'No Cloudflare accounts were authorized. Choose a Cloudflare account you can access and try again.';
  }
  if (outcome === 'error') return 'Cloudflare authorization could not be completed. Try again.';
}
