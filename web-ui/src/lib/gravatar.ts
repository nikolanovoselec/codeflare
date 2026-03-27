import { md5 } from './md5';

export function getGravatarUrl(email: string, size = 32): string {
  const hash = md5(email.trim().toLowerCase());
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=404`;
}
