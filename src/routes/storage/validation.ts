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
  // CF-012/CF-066: Decode once before the path-traversal check. This rejects
  // single-encoded sequences such as %2E%2E that decode to '..'. It does NOT
  // detect double-encoded input (%252E%252E decodes once to the literal '%2E%2E',
  // which contains no '..' and so passes). That is safe here: the returned key is
  // used verbatim as an R2 object key (see getR2Url in lib/r2-client.ts) and is
  // never decoded again, so a stored '%2E%2E' is an inert literal key segment and
  // cannot traverse.
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
