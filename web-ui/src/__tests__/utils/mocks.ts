import type { Session, UserInfo } from '../../types';

/**
 * Create a mock Session object
 */
export function createMockSession(overrides: Partial<Session> = {}): Session {
  const now = new Date().toISOString();
  return {
    id: 'mock-session-' + Math.random().toString(36).substring(2, 10),
    name: 'Test Session',
    createdAt: now,
    lastAccessedAt: now,
    status: 'stopped' as const,
    ...overrides,
  };
}

/**
 * Create a mock UserInfo object
 */
export function createMockUserInfo(overrides: Partial<UserInfo> = {}): UserInfo {
  return {
    email: 'test@example.com',
    authenticated: true,
    bucketName: 'codeflare-test-example-com',
    ...overrides,
  };
}

