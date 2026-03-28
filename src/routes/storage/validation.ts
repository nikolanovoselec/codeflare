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
  // CF-012: Decode URI-encoded sequences before path traversal check
  // to catch %2E%2E and double-encoded (%252E%252E) attacks.
  let decoded: string;
  try {
    decoded = decodeURIComponent(sanitized);
  } catch {
    throw new ValidationError(`Invalid ${label}: malformed URI encoding`);
  }
  if (decoded.includes('..')) {
    throw new ValidationError(`Invalid ${label}: path traversal not allowed`);
  }
  if (sanitized.startsWith('/')) {
    throw new ValidationError(`Invalid ${label}: must not start with /`);
  }
  if (PROTECTED_PATHS.length > 0) {
    for (const protected_ of PROTECTED_PATHS) {
      if (decoded.startsWith(protected_) || decoded.includes(`/${protected_}`)) {
        throw new ValidationError(`Cannot access protected path: ${protected_}`);
      }
    }
  }
  return decoded;
}
