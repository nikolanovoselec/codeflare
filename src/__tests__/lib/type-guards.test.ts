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
  });
});
