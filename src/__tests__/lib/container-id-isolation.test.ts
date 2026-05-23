/**
 * REQ-SESSION-002: One container per session (isolation)
 * AC coverage: AC1 (deterministic container ID derivation),
 *              AC2 (unique DO per session), AC3 (separate containers per user)
 *
 * AC4 (file/process/network isolation) is an infrastructure guarantee of the
 * Container DO runtime, not testable in unit/integration tests. AC4 is
 * architectural - each DO is a separate sandboxed process.
 */
import { describe, it, expect } from 'vitest';
import { getContainerId } from '../../lib/container-helpers';
import { SESSION_ID_PATTERN } from '../../lib/constants';

describe('REQ-SESSION-002: One container per session (isolation)', () => {
  // AC1: POST /api/container/start?sessionId=xxx derives a deterministic container ID
  //      from the user's bucket name and the session ID
  describe('REQ-SESSION-002 AC1: deterministic container ID from bucketName and sessionId', () => {
    it('derives container ID as bucketName-sessionId', () => {
      const containerId = getContainerId('user-bucket', 'abcdef1234567890abcdef12');
      // Production formula: `${bucketName}-${sessionId}`
      expect(containerId).toBe('user-bucket-abcdef1234567890abcdef12');
    });

    it('same inputs always produce the same container ID (deterministic)', () => {
      const id1 = getContainerId('my-bucket', 'aabbccdd11223344');
      const id2 = getContainerId('my-bucket', 'aabbccdd11223344');
      expect(id1).toBe(id2);
    });

    it('container ID starts with bucket name prefix', () => {
      const bucketName = 'user-test-bucket';
      const sessionId = 'a1b2c3d4e5f6a7b8';
      const containerId = getContainerId(bucketName, sessionId);
      expect(containerId.startsWith(bucketName + '-')).toBe(true);
    });

    it('container ID ends with session ID suffix', () => {
      const bucketName = 'user-bucket';
      const sessionId = 'deadbeef12345678';
      const containerId = getContainerId(bucketName, sessionId);
      expect(containerId.endsWith('-' + sessionId)).toBe(true);
    });

    it('throws ValidationError for sessionId not matching SESSION_ID_PATTERN', () => {
      expect(() => getContainerId('bucket', 'UPPER-CASE')).toThrow();
      expect(() => getContainerId('bucket', '')).toThrow();
      expect(() => getContainerId('bucket', 'too-short')).toThrow();
      expect(() => getContainerId('bucket', 'a'.repeat(25))).toThrow();
    });
  });

  // AC2: The container ID uniquely addresses a single Durable Object;
  //      no two sessions share a DO
  describe('REQ-SESSION-002 AC2: different sessions produce different container IDs', () => {
    it('two different session IDs for same bucket produce different container IDs', () => {
      const bucket = 'shared-bucket';
      const sid1 = 'aabbccdd11223344';
      const sid2 = 'eeff001122334455';
      expect(getContainerId(bucket, sid1)).not.toBe(getContainerId(bucket, sid2));
    });

    it('container IDs from different session IDs are completely distinct strings', () => {
      const ids = new Set<string>();
      const sessionIds = [
        'a0b1c2d3e4f5a6b7',
        'b1c2d3e4f5a6b7c8',
        'c2d3e4f5a6b7c8d9',
        'd3e4f5a6b7c8d9e0',
      ];
      for (const sid of sessionIds) {
        ids.add(getContainerId('bucket', sid));
      }
      expect(ids.size).toBe(sessionIds.length);
    });
  });

  // AC3: Different sessions belonging to the same user run in separate containers
  describe('REQ-SESSION-002 AC3: sessions for same user have separate container IDs', () => {
    it('two sessions for the same user bucket produce separate container IDs', () => {
      const userBucket = 'alice-bucket';
      const session1 = 'aaaa1111bbbb2222';
      const session2 = 'cccc3333dddd4444';

      const container1 = getContainerId(userBucket, session1);
      const container2 = getContainerId(userBucket, session2);

      expect(container1).not.toBe(container2);
      // Both reference the same user but are distinct DO addresses
      expect(container1).toContain(userBucket);
      expect(container2).toContain(userBucket);
    });

    it('SESSION_ID_PATTERN accepts valid 8-24 char lowercase hex IDs', () => {
      // Minimum length: 8 chars
      expect(SESSION_ID_PATTERN.test('a1b2c3d4')).toBe(true);
      // Maximum length: 24 chars
      expect(SESSION_ID_PATTERN.test('a'.repeat(24))).toBe(true);
      // Typical 24-char hex ID
      expect(SESSION_ID_PATTERN.test('abcdef1234567890abcdef12')).toBe(true);
      // Rejects uppercase
      expect(SESSION_ID_PATTERN.test('ABCDEF1234567890ABCDEF12')).toBe(false);
      // Rejects too long
      expect(SESSION_ID_PATTERN.test('a'.repeat(25))).toBe(false);
      // Rejects too short
      expect(SESSION_ID_PATTERN.test('a'.repeat(7))).toBe(false);
    });
  });
});
