/**
 * Shared key validation for storage routes
 */
import { ValidationError } from '../../lib/error-types';
import { PROTECTED_PATHS } from '../../lib/constants';

export const MAX_KEY_LENGTH = 1024;

export function validateKey(key: string, label = 'key'): void {
  if (!key || typeof key !== 'string') {
    throw new ValidationError(`${label} is required`);
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new ValidationError(`${label} must be at most ${MAX_KEY_LENGTH} characters`);
  }
  if (key.includes('..')) {
    throw new ValidationError(`Invalid ${label}: path traversal not allowed`);
  }
  if (key.startsWith('/')) {
    throw new ValidationError(`Invalid ${label}: must not start with /`);
  }
  for (const protected_ of PROTECTED_PATHS) {
    if (key.startsWith(protected_) || key.includes(`/${protected_}`)) {
      throw new ValidationError(`Cannot access protected path: ${protected_}`);
    }
  }
}
