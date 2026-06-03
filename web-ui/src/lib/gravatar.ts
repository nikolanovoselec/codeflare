import { md5 } from './md5';

export function getGravatarUrl(email: string, size = 32): string {
  const hash = md5(email.trim().toLowerCase());
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=404`;
}

/**
 * Probe whether a Gravatar exists for this email without an `<img onError>`
 * (which logs a red "Failed to load resource: 404" to the console on every
 * cached miss). `d=404` makes Gravatar 404 when the user has no avatar; a
 * `fetch` resolves silently on 404 (response.ok === false), so the console
 * stays clean and the shield-icon fallback still renders. Gravatar sends
 * `access-control-allow-origin: *` on the 404, so the cross-origin probe is
 * not blocked. Returns false on any network error.
 */
export async function gravatarExists(email: string, size = 32): Promise<boolean> {
  try {
    const res = await fetch(getGravatarUrl(email, size), { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}
