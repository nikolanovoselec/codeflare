import { describe, it, expect } from 'vitest';
import { isBucketNameResponse } from '../../lib/type-guards';

describe('isBucketNameResponse', () => {
  it('returns true for valid response with string', () => {
    expect(isBucketNameResponse({ bucketName: 'my-bucket' })).toBe(true);
  });

  it('returns true for valid response with null', () => {
    expect(isBucketNameResponse({ bucketName: null })).toBe(true);
  });

  it('returns false for missing bucketName', () => {
    expect(isBucketNameResponse({})).toBe(false);
    expect(isBucketNameResponse({ bucket: 'name' })).toBe(false);
  });

  it('returns false for non-objects', () => {
    expect(isBucketNameResponse(null)).toBe(false);
    expect(isBucketNameResponse(undefined)).toBe(false);
    expect(isBucketNameResponse('string')).toBe(false);
    expect(isBucketNameResponse(42)).toBe(false);
  });

  it('returns false when bucketName is present but neither string nor null', () => {
    // CF-042: the type guard narrows to `string | null` - a numeric, boolean,
    // object, or undefined bucketName must be rejected even though the key exists.
    expect(isBucketNameResponse({ bucketName: 42 })).toBe(false);
    expect(isBucketNameResponse({ bucketName: true })).toBe(false);
    expect(isBucketNameResponse({ bucketName: undefined })).toBe(false);
    expect(isBucketNameResponse({ bucketName: { nested: 'x' } })).toBe(false);
  });
});
