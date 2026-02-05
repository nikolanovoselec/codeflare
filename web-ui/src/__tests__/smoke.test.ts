import { describe, it, expect, vi } from 'vitest';
import { createMockSession, createMockUserInfo } from './utils/mocks';

describe('Test Infrastructure Smoke Tests', () => {
  describe('Mock Factories', () => {
    it('should create a mock session with valid structure', () => {
      const session = createMockSession();

      expect(session.id).toMatch(/^mock-session-[a-z0-9]+$/);
      expect(session.name).toBe('Test Session');
      expect(session.status).toBe('stopped');
      expect(new Date(session.createdAt).getTime()).not.toBeNaN();
      expect(new Date(session.lastAccessedAt).getTime()).not.toBeNaN();
    });

    it('should create a mock session with overrides', () => {
      const session = createMockSession({
        id: 'custom-id',
        name: 'Custom Session',
      });

      expect(session.id).toBe('custom-id');
      expect(session.name).toBe('Custom Session');
    });

    it('should create a mock user info with valid structure', () => {
      const userInfo = createMockUserInfo();

      expect(userInfo.email).toBe('test@example.com');
      expect(userInfo.authenticated).toBe(true);
      expect(userInfo.bucketName).toMatch(/^codeflare-/);
    });

  });

  describe('Browser API Mocks', () => {
    it('should have localStorage mock available', () => {
      localStorage.setItem('test-key', 'test-value');
      expect(localStorage.getItem('test-key')).toBe('test-value');

      localStorage.removeItem('test-key');
      expect(localStorage.getItem('test-key')).toBeNull();
    });

    it('should have WebSocket mock available and synchronously open', () => {
      const ws = new WebSocket('ws://localhost/test');
      expect(ws.url).toBe('ws://localhost/test');
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });

    it('should have ResizeObserver mock with observe/unobserve/disconnect methods', () => {
      const callback = vi.fn();
      const observer = new ResizeObserver(callback);
      const div = document.createElement('div');

      // Verify methods exist and are callable without throwing
      expect(() => observer.observe(div)).not.toThrow();
      expect(() => observer.unobserve(div)).not.toThrow();
      expect(() => observer.disconnect()).not.toThrow();
    });
  });

  describe('Vitest Configuration', () => {
    it('should have globals available', () => {
      // These are provided by globals: true in vitest config
      expect(typeof describe).toBe('function');
      expect(typeof it).toBe('function');
      expect(typeof expect).toBe('function');
    });

    it('should have jest-dom matchers available', () => {
      const div = document.createElement('div');
      div.textContent = 'Hello';
      document.body.appendChild(div);

      expect(div).toBeInTheDocument();
      expect(div).toHaveTextContent('Hello');

      document.body.removeChild(div);
    });
  });
});
