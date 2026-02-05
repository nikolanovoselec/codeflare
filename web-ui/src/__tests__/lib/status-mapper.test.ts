import { describe, it, expect } from 'vitest';
import { mapStartupDetailsToProgress } from '../../lib/status-mapper';
import type { StartupStatusResponse } from '../../types';

describe('mapStartupDetailsToProgress', () => {
  function createStatus(overrides: Partial<StartupStatusResponse> = {}): StartupStatusResponse {
    return {
      stage: 'starting',
      progress: 50,
      message: 'Starting container...',
      details: {
        bucketName: 'codeflare-test',
        container: 'test-container-id',
        path: '/workspace',
        ...overrides.details,
      },
      ...overrides,
    };
  }

  describe('container status mapping', () => {
    it('maps running to ok status', () => {
      const result = mapStartupDetailsToProgress(
        createStatus({ details: { bucketName: 'b', container: 'c', path: 'p', containerStatus: 'running' } })
      );

      const container = result.details?.find((d) => d.key === 'Container');
      expect(container?.value).toBe('Running');
      expect(container?.status).toBe('ok');
    });

    it('maps healthy to ok status', () => {
      const result = mapStartupDetailsToProgress(
        createStatus({ details: { bucketName: 'b', container: 'c', path: 'p', containerStatus: 'healthy' } })
      );

      const container = result.details?.find((d) => d.key === 'Container');
      expect(container?.value).toBe('Running');
      expect(container?.status).toBe('ok');
    });

    it('maps stopped to pending status', () => {
      const result = mapStartupDetailsToProgress(
        createStatus({ details: { bucketName: 'b', container: 'c', path: 'p', containerStatus: 'stopped' } })
      );

      const container = result.details?.find((d) => d.key === 'Container');
      expect(container?.value).toBe('stopped');
      expect(container?.status).toBe('pending');
    });

    it('defaults to stopped when containerStatus is missing', () => {
      const result = mapStartupDetailsToProgress(
        createStatus({ details: { bucketName: 'b', container: 'c', path: 'p' } })
      );

      const container = result.details?.find((d) => d.key === 'Container');
      expect(container?.value).toBe('stopped');
      expect(container?.status).toBe('pending');
    });
  });

  describe('sync status mapping', () => {
    it('maps success to Synced with ok status', () => {
      const result = mapStartupDetailsToProgress(
        createStatus({ details: { bucketName: 'b', container: 'c', path: 'p', syncStatus: 'success' } })
      );

      const sync = result.details?.find((d) => d.key === 'Sync');
      expect(sync?.value).toBe('Synced');
      expect(sync?.status).toBe('ok');
    });

    it('maps failed to error message with error status', () => {
      const result = mapStartupDetailsToProgress(
        createStatus({
          details: { bucketName: 'b', container: 'c', path: 'p', syncStatus: 'failed', syncError: 'R2 timeout' },
        })
      );

      const sync = result.details?.find((d) => d.key === 'Sync');
      expect(sync?.value).toBe('R2 timeout');
      expect(sync?.status).toBe('error');
    });

    it('maps failed without syncError to generic Failed', () => {
      const result = mapStartupDetailsToProgress(
        createStatus({
          details: { bucketName: 'b', container: 'c', path: 'p', syncStatus: 'failed' },
        })
      );

      const sync = result.details?.find((d) => d.key === 'Sync');
      expect(sync?.value).toBe('Failed');
      expect(sync?.status).toBe('error');
    });

    it('maps syncing to Syncing... with pending status', () => {
      const result = mapStartupDetailsToProgress(
        createStatus({ details: { bucketName: 'b', container: 'c', path: 'p', syncStatus: 'syncing' } })
      );

      const sync = result.details?.find((d) => d.key === 'Sync');
      expect(sync?.value).toBe('Syncing...');
      expect(sync?.status).toBe('pending');
    });

    it('maps skipped to Skipped with ok status', () => {
      const result = mapStartupDetailsToProgress(
        createStatus({ details: { bucketName: 'b', container: 'c', path: 'p', syncStatus: 'skipped' } })
      );

      const sync = result.details?.find((d) => d.key === 'Sync');
      expect(sync?.value).toBe('Skipped');
      expect(sync?.status).toBe('ok');
    });

    it('defaults to Pending with pending status when syncStatus is missing', () => {
      const result = mapStartupDetailsToProgress(
        createStatus({ details: { bucketName: 'b', container: 'c', path: 'p' } })
      );

      const sync = result.details?.find((d) => d.key === 'Sync');
      expect(sync?.value).toBe('Pending');
      expect(sync?.status).toBe('pending');
    });
  });

  describe('terminal status mapping', () => {
    it('maps terminalServerOk to Ready with ok status', () => {
      const result = mapStartupDetailsToProgress(
        createStatus({
          details: { bucketName: 'b', container: 'c', path: 'p', terminalServerOk: true, healthServerOk: true },
        })
      );

      const terminal = result.details?.find((d) => d.key === 'Terminal');
      expect(terminal?.value).toBe('Ready');
      expect(terminal?.status).toBe('ok');
    });

    it('maps healthServerOk without terminalServerOk to Starting...', () => {
      const result = mapStartupDetailsToProgress(
        createStatus({
          details: { bucketName: 'b', container: 'c', path: 'p', terminalServerOk: false, healthServerOk: true },
        })
      );

      const terminal = result.details?.find((d) => d.key === 'Terminal');
      expect(terminal?.value).toBe('Starting...');
      expect(terminal?.status).toBe('pending');
    });

    it('defaults to Starting with pending when neither server is ok', () => {
      const result = mapStartupDetailsToProgress(
        createStatus({
          details: { bucketName: 'b', container: 'c', path: 'p', terminalServerOk: false, healthServerOk: false },
        })
      );

      const terminal = result.details?.find((d) => d.key === 'Terminal');
      expect(terminal?.value).toBe('Starting');
      expect(terminal?.status).toBe('pending');
    });
  });

  describe('email detail', () => {
    it('includes User detail when email is present', () => {
      const result = mapStartupDetailsToProgress(
        createStatus({
          details: { bucketName: 'b', container: 'c', path: 'p', email: 'alice@example.com' },
        })
      );

      const user = result.details?.find((d) => d.key === 'User');
      expect(user?.value).toBe('alice@example.com');
      expect(user?.status).toBe('ok');
    });

    it('omits User detail when email is not present', () => {
      const result = mapStartupDetailsToProgress(
        createStatus({ details: { bucketName: 'b', container: 'c', path: 'p' } })
      );

      const user = result.details?.find((d) => d.key === 'User');
      expect(user).toBeUndefined();
    });
  });

  describe('top-level fields', () => {
    it('passes through stage, progress, and message', () => {
      const result = mapStartupDetailsToProgress(
        createStatus({ stage: 'ready', progress: 100, message: 'Container ready' })
      );

      expect(result.stage).toBe('ready');
      expect(result.progress).toBe(100);
      expect(result.message).toBe('Container ready');
    });
  });

  describe('empty details handling', () => {
    it('returns empty details array when status.details is undefined', () => {
      const status = {
        stage: 'creating' as const,
        progress: 0,
        message: 'Creating...',
        details: undefined as unknown as StartupStatusResponse['details'],
      };

      const result = mapStartupDetailsToProgress(status);

      expect(result.details).toEqual([]);
    });
  });
});
