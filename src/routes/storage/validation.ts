/**
 * Shared key validation for storage routes
 */
import { ValidationError } from '../../lib/error-types';
import { PROTECTED_PATHS } from '../../lib/constants';

export const MAX_KEY_LENGTH = 1024;

export function validateKey(key: string, label = 'key'): string {
  if (!key || typeof key !== 'string') {
    throw new ValidationError(`${label} is required`);
  }
  const sanitized = key.replace(/\0/g, '');
  if (sanitized.length > MAX_KEY_LENGTH) {
    throw new ValidationError(`${label} must be at most ${MAX_KEY_LENGTH} characters`);
  }
  if (sanitized.includes('..')) {
    throw new ValidationError(`Invalid ${label}: path traversal not allowed`);
  }
  if (sanitized.startsWith('/')) {
    throw new ValidationError(`Invalid ${label}: must not start with /`);
  }
  for (const protected_ of PROTECTED_PATHS) {
    if (sanitized.startsWith(protected_) || sanitized.includes(`/${protected_}`)) {
      throw new ValidationError(`Cannot access protected path: ${protected_}`);
    }
  }
  return sanitized;
}
